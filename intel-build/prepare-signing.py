"""Import the persistent signing identity into an ephemeral macOS runner keychain."""
import base64
import os
from pathlib import Path
import subprocess
import tempfile


def security(stage, arguments):
    # Passwords are command arguments to Apple's tool; never render a failed command or its arguments.
    result = subprocess.run(["/usr/bin/security", *arguments], capture_output=True)
    if result.returncode:
        raise RuntimeError(f"macOS signing setup failed at {stage} (exit {result.returncode})")


directory = Path(tempfile.mkdtemp(prefix="harness-signing-", dir=os.environ["RUNNER_TEMP"]))
keychain = directory / "signing.keychain-db"
p12 = directory / "identity.p12"
password = os.environ["MACOS_SIGNING_PASSWORD"]
certificate = Path("intel-build/signing-cert.pem").resolve()
p12.write_bytes(base64.b64decode(os.environ["MACOS_SIGNING_P12_BASE64"], validate=True))
p12.chmod(0o600)
try:
    security("create-keychain", ["create-keychain", "-p", password, str(keychain)])
    security("keychain-timeout", ["set-keychain-settings", "-lut", "21600", str(keychain)])
    security("unlock-keychain", ["unlock-keychain", "-p", password, str(keychain)])
    security("import-identity", ["import", str(p12), "-k", str(keychain), "-P", password, "-T", "/usr/bin/codesign"])
    security("code-signing-trust", ["add-trusted-cert", "-r", "trustRoot", "-p", "codeSign", "-k", str(keychain), str(certificate)])
    security("key-access", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, str(keychain)])
    with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as file:
        file.write(f"HARNESS_SIGNING_KEYCHAIN={keychain}\nHARNESS_SIGNING_CERTIFICATE={certificate}\n")
finally:
    p12.unlink(missing_ok=True)
print("Imported the pinned personal signing certificate; private material remains on this runner only.")
