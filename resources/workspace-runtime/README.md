# PDF workspace runtime

The desktop host installs this runtime on demand into its own profile directory.
The agent obtains the absolute Python executable through
`load_workspace_dependencies` and runs PDF scripts with that executable.
It does not rely on system Python, Homebrew, or command-line Poppler programs.
Page rendering is provided by the native PDFium library in the `pypdfium2` wheel.

`manifest.json` pins the Python and uv versions, supported platforms, uv archive
SHA-256 values, and Python package versions. `requirements.lock` includes exact
versions and the official PyPI SHA-256 values for every permitted wheel.
Installation requires wheels and hashes, disables external uv configuration,
uses the official PyPI index, and leaves system Python and its packages alone.
Python is installed without global executable links or Windows registration.

The installation becomes ready only after a probe creates a PDF, extracts its
text with both text libraries, and renders a page through PDFium. A versioned
environment is written in place because Python virtual environments contain
absolute interpreter paths; an atomic ready marker records successful validation.
Interrupted environments are rebuilt. A cross-process profile lock prevents
concurrent installers from modifying the same environment. Earlier versions are
retained when a new version fails.

## Updating pins

1. Select supported patch releases from the official release sources below.
2. Fetch the uv release's `.sha256` files and update both supported archive pins.
3. Generate wheel hashes from `https://pypi.org/pypi/<package>/<version>/json`.
   Pin the complete transitive dependency set. Do not allow source distributions.
4. Update the manifest and lock together; their combined digest determines the
   installation directory. Keep the schema version stable unless its shape changes.
5. Run the manager tests and a clean-profile installation on each supported OS.
   Verify PDF extraction and rendering, shutdown cancellation, and reuse after restart.

## Sources and licenses

- [uv releases](https://github.com/astral-sh/uv/releases)
  (MIT or Apache-2.0) and
  [managed Python documentation](https://docs.astral.sh/uv/guides/install-python/).
- [CPython](https://www.python.org/downloads/) (PSF license); uv uses
  [python-build-standalone](https://github.com/astral-sh/python-build-standalone)
  distributions with their bundled license notices.
- [pypdf](https://pypi.org/project/pypdf/) (BSD-3-Clause),
  [pdfplumber](https://pypi.org/project/pdfplumber/) (MIT), and
  [reportlab](https://pypi.org/project/reportlab/) (BSD license).
- [pypdfium2](https://pypi.org/project/pypdfium2/) (Apache-2.0 or BSD-3-Clause)
  includes PDFium and its third-party license notices in the installed wheel.
  Dependency license files remain in the managed runtime.
