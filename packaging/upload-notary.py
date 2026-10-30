"""Upload exactly Apple's Notary object; credentials arrive only through stdin."""
import importlib.metadata
import json
import os
import sys

VERSIONS = {"boto3": "1.43.93", "botocore": "1.43.93", "s3transfer": "0.19.2"}


def main():
    versions = {name: importlib.metadata.version(name) for name in VERSIONS}
    if versions != VERSIONS:
        raise ValueError("dependency-version")
    if sys.argv[1:] == ["--check"]:
        print(json.dumps(versions), flush=True)
        return
    if sys.argv[1:]:
        raise ValueError("unexpected-arguments")
    import boto3
    from boto3.s3.transfer import TransferConfig
    from botocore.config import Config

    request = json.load(sys.stdin)
    attributes = request["attributes"]
    if os.path.getsize(request["file"]) != request["expectedBytes"]:
        raise ValueError("artifact-size")
    completion = {}

    def completed(parsed, **_kwargs):
        completion["httpStatus"] = parsed.get("ResponseMetadata", {}).get("HTTPStatusCode")

    client = boto3.client(
        "s3", region_name="us-west-2",
        aws_access_key_id=attributes["awsAccessKeyId"],
        aws_secret_access_key=attributes["awsSecretAccessKey"],
        aws_session_token=attributes["awsSessionToken"],
        config=Config(signature_version="s3v4",
                      s3={"use_accelerate_endpoint": False, "addressing_style": "virtual"},
                      connect_timeout=10, read_timeout=45,
                      retries={"total_max_attempts": 2}),
    )
    client.meta.events.register("after-call.s3.CompleteMultipartUpload", completed)
    client.meta.events.register("after-call.s3.PutObject", completed)
    try:
        client.upload_file(request["file"], attributes["bucket"], attributes["object"],
                           Config=TransferConfig(multipart_threshold=5 * 1024 * 1024,
                                                 multipart_chunksize=5 * 1024 * 1024,
                                                 max_concurrency=2))
        if completion.get("httpStatus") != 200:
            raise ValueError("upload-not-confirmed")
        print(json.dumps({"httpStatus": 200, "uploadedBytes": request["expectedBytes"]}), flush=True)
    finally:
        client.close()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # SDK exceptions can include signed URLs or credential-bearing responses.
        print("Notary uploader failed; no credentials were logged", file=sys.stderr)
        sys.exit(1)
