//! Committed wire grammar: no commands, environment, paths, or engine requests execute here.
use super::{error, Options, MAX_PAYLOAD};
use crate::Result;

pub fn validate(cwd: &str, args: &[String]) -> Result<()> {
    if cwd.len() > 4096
        || cwd.contains('\0')
        || args.len() > 64
        || args
            .iter()
            .any(|arg| arg.len() > 4096 || arg.contains('\0'))
        || cwd.len() + args.iter().map(|s| s.len() + 1).sum::<usize>() + 2 > MAX_PAYLOAD
    {
        return Err(error("INSTANCE_INVALID_MESSAGE"));
    }
    Ok(())
}

pub fn encode_macos(options: &Options) -> Vec<u8> {
    format!("{}\0\0{}", options.cwd, options.args.join("\0")).into_bytes()
}
pub fn decode_macos(bytes: &[u8]) -> Result<(String, Vec<String>)> {
    if bytes.len() > MAX_PAYLOAD {
        return Err(error("INSTANCE_INVALID_MESSAGE"));
    }
    let text = std::str::from_utf8(bytes).map_err(|_| error("INSTANCE_INVALID_MESSAGE"))?;
    let (cwd, args) = text
        .split_once("\0\0")
        .ok_or_else(|| error("INSTANCE_INVALID_MESSAGE"))?;
    let args: Vec<String> = if args.is_empty() {
        vec![]
    } else {
        args.split('\0').map(str::to_owned).collect()
    };
    validate(cwd, &args)?;
    Ok((cwd.into(), args))
}

pub fn encode_windows(options: &Options) -> Result<Vec<u8>> {
    if options.cwd.contains('|') || options.args.iter().any(|arg| arg.contains('|')) {
        return Err(error("INSTANCE_INVALID_MESSAGE"));
    }
    Ok(format!("{}|{}\0", options.cwd, options.args.join("|")).into_bytes())
}
pub fn decode_windows(bytes: &[u8]) -> Result<(String, Vec<String>)> {
    if bytes.is_empty() || bytes.len() > MAX_PAYLOAD || bytes.last() != Some(&0) {
        return Err(error("INSTANCE_INVALID_MESSAGE"));
    }
    let text = std::str::from_utf8(&bytes[..bytes.len() - 1])
        .map_err(|_| error("INSTANCE_INVALID_MESSAGE"))?;
    let (cwd, args) = text
        .split_once('|')
        .ok_or_else(|| error("INSTANCE_INVALID_MESSAGE"))?;
    let args: Vec<String> = if args.is_empty() {
        vec![]
    } else {
        args.split('|').map(str::to_owned).collect()
    };
    validate(cwd, &args)?;
    Ok((cwd.into(), args))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_wire_vectors_and_limits() {
        let options = Options {
            identity: "ai.klaus.desktop.fixture".into(),
            cwd: "/tmp/目录".into(),
            args: vec!["Klaus".into(), "klaus://open/abc".into()],
            timeout_ms: 1000,
        };
        assert_eq!(
            encode_macos(&options),
            b"/tmp/\xe7\x9b\xae\xe5\xbd\x95\0\0Klaus\0klaus://open/abc"
        );
        assert_eq!(
            decode_macos(&encode_macos(&options)).unwrap(),
            (options.cwd.clone(), options.args.clone())
        );
        assert_eq!(
            encode_windows(&options).unwrap(),
            b"/tmp/\xe7\x9b\xae\xe5\xbd\x95|Klaus|klaus://open/abc\0"
        );
        assert_eq!(
            decode_windows(&encode_windows(&options).unwrap()).unwrap(),
            (options.cwd.clone(), options.args.clone())
        );
        for malformed in [b"cwd\0arg".as_slice(), b"cwd\0\0\xff"] {
            assert!(decode_macos(malformed).is_err());
        }
        assert_eq!(
            decode_macos(b"cwd\0\0bad\0\0bad").unwrap().1,
            vec!["bad", "", "bad"]
        );
        for malformed in [b"cwd|arg".as_slice(), b"cwd|\xff\0", b"cwd|bad\0bad\0"] {
            assert!(decode_windows(malformed).is_err());
        }
        assert!(decode_macos(&vec![b'a'; MAX_PAYLOAD + 1]).is_err());
        assert!(validate("", &vec!["a".into(); 65]).is_err());
        assert!(validate(&"a".repeat(4097), &[]).is_err());
    }
}
