"""Minimal HS256 JSON Web Tokens (RFC 7519) using only the standard library.

Only HS256 is produced or accepted: the header's ``alg`` is checked against a
fixed value (no ``none``/algorithm-confusion), signatures are compared in
constant time, and ``exp``/``nbf``/``iss`` are validated.
"""

import base64
import hashlib
import hmac
import json
import time

HEADER = {"alg": "HS256", "typ": "JWT"}
LEEWAY = 30


class InvalidToken(Exception):
    pass


def _b64e(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64d(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def encode(claims, secret):
    signing_input = f"{_b64e(json.dumps(HEADER, separators=(',', ':')).encode())}." \
                    f"{_b64e(json.dumps(claims, separators=(',', ':')).encode())}"
    signature = hmac.new(secret, signing_input.encode(), hashlib.sha256).digest()
    return f"{signing_input}.{_b64e(signature)}"


def decode(token, secret, issuer, verify_exp=True):
    try:
        header_b64, claims_b64, sig_b64 = token.split(".")
        header = json.loads(_b64d(header_b64))
        if header.get("alg") != "HS256" or header.get("typ", "JWT") != "JWT":
            raise InvalidToken("unsupported algorithm")
        expected = hmac.new(secret, f"{header_b64}.{claims_b64}".encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _b64d(sig_b64)):
            raise InvalidToken("bad signature")
        claims = json.loads(_b64d(claims_b64))
    except InvalidToken:
        raise
    except Exception as e:
        raise InvalidToken(f"malformed token: {e}")
    now = time.time()
    if claims.get("iss") != issuer:
        raise InvalidToken("wrong issuer")
    if verify_exp and now > float(claims.get("exp", 0)) + LEEWAY:
        raise InvalidToken("expired")
    if now + LEEWAY < float(claims.get("nbf", 0)):
        raise InvalidToken("not yet valid")
    return claims
