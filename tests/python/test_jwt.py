"""HS256 tokens: round trip, tampering, expiry, issuer, algorithm confusion."""

import base64
import json
import time

import pytest

from rigshare_core import jwt

SECRET = b"s3cret"


def claims(**extra):
    return {"iss": "rig", "exp": time.time() + 60, **extra}


def b64(obj):
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()


def test_round_trip():
    token = jwt.encode(claims(sub="bob"), SECRET)
    assert jwt.decode(token, SECRET, "rig")["sub"] == "bob"


def test_wrong_secret_and_tampered_payload():
    token = jwt.encode(claims(sub="bob"), SECRET)
    with pytest.raises(jwt.InvalidToken):
        jwt.decode(token, b"other", "rig")
    head, _, sig = token.split(".")
    forged = f"{head}.{b64(claims(sub='admin'))}.{sig}"
    with pytest.raises(jwt.InvalidToken):
        jwt.decode(forged, SECRET, "rig")


def test_expiry_leeway_and_not_before():
    with pytest.raises(jwt.InvalidToken):
        jwt.decode(jwt.encode({"iss": "rig", "exp": time.time() - 3600}, SECRET), SECRET, "rig")
    jwt.decode(jwt.encode({"iss": "rig", "exp": time.time() - 5}, SECRET), SECRET, "rig")  # inside leeway
    assert jwt.decode(jwt.encode({"iss": "rig", "exp": time.time() - 3600}, SECRET), SECRET, "rig", verify_exp=False)
    with pytest.raises(jwt.InvalidToken):
        jwt.decode(jwt.encode(claims(nbf=time.time() + 3600), SECRET), SECRET, "rig")


def test_wrong_issuer():
    with pytest.raises(jwt.InvalidToken):
        jwt.decode(jwt.encode(claims(), SECRET), SECRET, "someone-else")


def test_alg_none_is_refused():
    token = f"{b64({'alg': 'none', 'typ': 'JWT'})}.{b64(claims())}."
    with pytest.raises(jwt.InvalidToken):
        jwt.decode(token, SECRET, "rig")


@pytest.mark.parametrize("junk", ["", "a.b", "a.b.c.d", "!!!.???.***", "e30.e30.e30"])
def test_malformed_tokens(junk):
    with pytest.raises(jwt.InvalidToken):
        jwt.decode(junk, SECRET, "rig")
