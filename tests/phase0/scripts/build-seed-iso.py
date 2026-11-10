#!/usr/bin/env python3
"""Build a cloud-init NoCloud seed ISO for phase-0 validation VMs.

Requires pycdlib: python3 -m venv .venv && .venv/bin/pip install pycdlib
The script never runs the image; it only packages user-data and meta-data.
"""
import argparse
import io
from pathlib import Path

import pycdlib


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--template", required=True, type=Path)
    parser.add_argument("--ssh-public-key", required=True, type=Path)
    parser.add_argument("--instance-id", required=True)
    parser.add_argument("--hostname", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    public_key = args.ssh_public_key.read_text(encoding="utf-8").strip()
    user_data = args.template.read_text(encoding="utf-8").replace("__SSH_PUBLIC_KEY__", public_key)
    meta_data = f"instance-id: {args.instance_id}\nlocal-hostname: {args.hostname}\n"

    iso = pycdlib.PyCdlib()
    iso.new(interchange_level=3, joliet=True, rock_ridge="1.12", vol_ident="CIDATA")
    for name, isoname, content in (
        ("user-data", "/USER_DATA.;1", user_data.encode()),
        ("meta-data", "/META_DATA.;1", meta_data.encode()),
    ):
        iso.add_fp(io.BytesIO(content), len(content), isoname, rr_name=name, joliet_path="/" + name)
    iso.write(str(args.output))
    iso.close()
    print(f"wrote {args.output}")


if __name__ == "__main__":
    main()
