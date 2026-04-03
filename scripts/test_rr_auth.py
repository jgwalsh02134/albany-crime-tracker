from __future__ import annotations

import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import httpx
from dotenv import load_dotenv
import os


SOAP_ENDPOINT = "https://api.radioreference.com/soap2/"
SYSTEM_ID = "8553"


def _repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _load_env() -> tuple[str, str, str]:
    load_dotenv(_repo_root() / ".env")
    api_key = (os.getenv("RADIOREFERENCE_API_KEY") or "").strip()
    username = (os.getenv("RADIOREFERENCE_USERNAME") or "").strip()
    password = (os.getenv("RADIOREFERENCE_PASSWORD") or "").strip()
    return api_key, username, password


def _soap_body(api_key: str, username: str, password: str) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:rr="http://api.radioreference.com/soap2/">
  <soap:Body>
    <rr:getTrsTalkgroups>
      <rr:sid>{SYSTEM_ID}</rr:sid>
      <rr:authInfo>
        <rr:appKey>{api_key}</rr:appKey>
        <rr:username>{username}</rr:username>
        <rr:password>{password}</rr:password>
        <rr:version>latest</rr:version>
        <rr:style>doc</rr:style>
      </rr:authInfo>
    </rr:getTrsTalkgroups>
  </soap:Body>
</soap:Envelope>"""


def _extract_fault(xml_text: str) -> str:
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return ""
    for elem in root.iter():
        tag_local = elem.tag.split("}")[-1] if "}" in elem.tag else elem.tag
        if tag_local in {"faultstring", "message", "detail"}:
            text = (elem.text or "").strip()
            if text:
                return text
    return ""


def _count_talkgroups(xml_text: str) -> int:
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return 0
    count = 0
    for elem in root.iter():
        tag_local = elem.tag.split("}")[-1] if "}" in elem.tag else elem.tag
        if tag_local in {"talkgroup", "item", "return"}:
            count += 1
    return count


def main() -> int:
    api_key, username, password = _load_env()
    if not api_key or not username or not password:
        print("Failure: missing RadioReference credentials in .env (status=N/A)")
        return 1

    body = _soap_body(api_key, username, password)
    try:
        with httpx.Client(timeout=15.0) as client:
            response = client.post(
                SOAP_ENDPOINT,
                content=body,
                headers={"Content-Type": "text/xml; charset=utf-8", "SOAPAction": ""},
            )
    except Exception as exc:
        print(f"Failure: request error (status=N/A) error={type(exc).__name__}: {exc}")
        return 1

    fault = _extract_fault(response.text)
    talkgroup_count = _count_talkgroups(response.text)
    raw_body = response.text.strip() or "(empty response body)"

    if response.status_code == 200 and not fault and talkgroup_count > 0:
        print(
            f"Success: authenticated to RadioReference SOAP API "
            f"(status={response.status_code}, endpoint={SOAP_ENDPOINT}, method=getTrsTalkgroups, sid={SYSTEM_ID}, talkgroups={talkgroup_count})"
        )
        print("Raw response body:")
        print(raw_body)
        return 0

    detail = fault or response.text[:200].replace("\n", " ").strip() or "unknown error"
    print(
        f"Failure: RadioReference auth/request failed "
        f"(status={response.status_code}, endpoint={SOAP_ENDPOINT}, method=getTrsTalkgroups, sid={SYSTEM_ID}, error={detail})"
    )
    print("Raw response body:")
    print(raw_body)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
