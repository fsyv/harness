"""Import the persistent signing identity into an ephemeral macOS runner keychain."""
import base64
import hashlib
import os
from pathlib import Path
import shlex
import shutil
import ssl
import subprocess
import tempfile


def run_tool(stage, command):
    # Passwords are command arguments to Apple's tool; never render a failed command or its arguments.
    print(f"Signing setup: {stage}", flush=True)
    try:
        result = subprocess.run(command, capture_output=True, encoding="utf-8", errors="replace", timeout=45)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"macOS signing setup timed out at {stage}") from None
    if result.returncode:
        detail = result.stderr.replace(os.environ["MACOS_SIGNING_PASSWORD"], "[redacted]")
        raise RuntimeError(f"macOS signing setup failed at {stage} (exit {result.returncode}): {detail}")
    return result.stdout


def security(stage, arguments, administrator=False):
    command = (["sudo", "-n"] if administrator else []) + ["/usr/bin/security", *arguments]
    return run_tool(stage, command)


directory = Path(tempfile.mkdtemp(prefix="harness-signing-", dir=os.environ["RUNNER_TEMP"]))
keychain = directory / "signing.keychain-db"
p12 = directory / "identity.p12"
probe = directory / "signing-probe"
password = os.environ["MACOS_SIGNING_PASSWORD"]
certificate = Path("intel-build/signing-cert.pem").resolve()
p12.write_bytes(base64.b64decode(os.environ["MACOS_SIGNING_P12_BASE64"], validate=True))
p12.chmod(0o600)
try:
    previous_keychains = shlex.split(security("read-search-list", ["list-keychains", "-d", "user"]))
    security("create-keychain", ["create-keychain", "-p", password, str(keychain)])
    with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as file:
        file.write(f"HARNESS_SIGNING_KEYCHAIN={keychain}\nHARNESS_SIGNING_CERTIFICATE={certificate}\n")
    security("keychain-timeout", ["set-keychain-settings", "-lut", "21600", str(keychain)])
    security("unlock-keychain", ["unlock-keychain", "-p", password, str(keychain)])
    security("import-identity", ["import", str(p12), "-k", str(keychain), "-P", password, "-T", "/usr/bin/codesign"])
    security("code-signing-trust", ["add-trusted-cert", "-d", "-r", "trustRoot", "-p", "codeSign",
                                   "-k", "/Library/Keychains/System.keychain", str(certificate)], administrator=True)
    security("key-access", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, str(keychain)])
    # codesign requires the custom keychain on the user search list even with --keychain.
    security("add-to-search-list", ["list-keychains", "-d", "user", "-s", str(keychain), *previous_keychains])
    fingerprint = hashlib.sha1(ssl.PEM_cert_to_DER_cert(certificate.read_text(encoding="ascii"))).hexdigest().upper()
    identities = security("check-signing-identity", ["find-identity", "-v", "-p", "codesigning", str(keychain)])
    if fingerprint not in identities:
        raise RuntimeError("The pinned personal certificate is not a valid signing identity in the runner keychain")
    shutil.copy("/usr/bin/true", probe)
    run_tool("sign-probe", ["/usr/bin/codesign", "--force", "--sign", fingerprint, "--keychain", str(keychain),
                            "--timestamp=none", str(probe)])
    run_tool("verify-probe", ["/usr/bin/codesign", "--verify", "--strict", str(probe)])
finally:
    p12.unlink(missing_ok=True)
    probe.unlink(missing_ok=True)
print("Verified the pinned personal signing identity with a native codesign probe.")
