"""CLI container adaptation and local raster import, matching the Web pipeline."""

from __future__ import annotations

import io
import json
import math
from pathlib import Path
import plistlib
import struct
import tempfile
import zipfile


def linear_i420_10(path, width, height, angle=0, mirror=None):
    """Inverse HEIF transform, colour-managed RGB, linear P3, then 10-bit I420."""
    import numpy as np
    from PIL import Image, ImageCms

    image = Image.open(path).convert("RGB")
    icc = image.info.get("icc_profile")
    profile = ImageCms.ImageCmsProfile(io.BytesIO(icc)) if icc else None
    is_p3 = bool(
        profile
        and "displayp3"
        in ImageCms.getProfileDescription(profile).lower().replace(" ", "")
    )
    if profile and not is_p3:
        image = ImageCms.profileToProfile(
            image, profile, ImageCms.createProfile("sRGB"), outputMode="RGB"
        )
    transform = {
        90: Image.Transpose.ROTATE_270,
        180: Image.Transpose.ROTATE_180,
        270: Image.Transpose.ROTATE_90,
    }
    if angle in transform:
        image = image.transpose(transform[angle])
    if mirror is not None:
        image = image.transpose(
            Image.Transpose.FLIP_LEFT_RIGHT
            if mirror == 0
            else Image.Transpose.FLIP_TOP_BOTTOM
        )
    image = image.resize((width, height), Image.Resampling.LANCZOS)
    rgb = np.asarray(image, dtype=np.float64) / 255
    linear = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    if not is_p3:
        # D65 sRGB -> Display P3, in linear light.
        linear = linear @ np.array(
            [
                [0.82259287, 0.03319951, 0.01708535],
                [0.17753395, 0.96678350, 0.07239572],
                [0.0, 0.0, 0.91030148],
            ]
        )
    linear = np.clip(linear, 0, 1)
    r, g, b = [linear[:, :, i] for i in range(3)]
    y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    cb = (b - y) / (2 * (1 - 0.0722))
    cr = (r - y) / (2 * (1 - 0.2126))

    def quantize(values, low, high):
        return np.clip(np.floor(values + 0.5), low, high).astype("<u2").tobytes()

    def chroma(values):
        return quantize(
            512 + 224 * values.reshape(height // 2, 2, width // 2, 2).sum(axis=(1, 3)),
            64,
            960,
        )

    return quantize(64 + 876 * y, 64, 940) + chroma(cb) + chroma(cr)


class Converter:
    def __init__(self, port):
        self.p = port

    def associations(self, meta, iid, entries):
        p = self.p
        props = p.parse_ipco_ipma(meta)
        associations = props["associations"].copy()
        associations[iid] = [
            dict(index=index, essential=essential) for index, essential in entries
        ]
        ao, size, header, _ = props["ipma_box"]
        version = meta[ao + header]
        flags = int.from_bytes(meta[ao + header + 1 : ao + header + 4], "big")
        wide = bool(flags & 1) or any(
            a["index"] > 127 for arr in associations.values() for a in arr
        )
        body = (
            bytes([version])
            + ((flags | 1) if wide else flags).to_bytes(3, "big")
            + len(associations).to_bytes(4, "big")
        )
        for item, arr in associations.items():
            if len(arr) > 255:
                raise p.PortError("Too many properties on one item")
            body += item.to_bytes(2 if version == 0 else 4, "big") + bytes([len(arr)])
            for a in arr:
                body += (
                    (0x8000 if wide else 0x80) * int(a["essential"]) + a["index"]
                ).to_bytes(2 if wide else 1, "big")
        return self.child(meta, "ipma", p._box("ipma", body), parent="iprp")

    def child(self, meta, kind, replacement, parent=None):
        p = self.p
        mo, ms, mh, _ = p.top_box(meta, "meta")
        parts = []
        for bo, bs, bh, bt in p.boxes(meta, mo + mh + 4, mo + ms):
            if parent and bt == parent:
                body = b"".join(
                    replacement if ct == kind else meta[co : co + cs]
                    for co, cs, _, ct in p.boxes(meta, bo + bh, bo + bs)
                )
                parts.append(p._box(parent, body))
            else:
                parts.append(replacement if bt == kind else meta[bo : bo + bs])
        return p._box("meta", meta[mo + mh : mo + mh + 4] + b"".join(parts))

    def property(self, meta, ids, kind, value):
        if value is None:
            return meta
        p = self.p
        props = p.parse_ipco_ipma(meta)
        index = next(
            (
                x["index"]
                for x in props["properties"]
                if meta[x["box"][0] : x["box"][0] + x["box"][1]] == value
            ),
            None,
        )
        if index is None:
            meta, index = p.append_ipco_property(meta, value)
        for iid in ids:
            props = p.parse_ipco_ipma(meta)
            entries = [
                (a["index"], a["essential"])
                for a in props["associations"].get(iid, [])
                if props["properties"][a["index"] - 1]["type"]
                not in (("colr", "clli", "mdcv") if kind == "colr" else (kind,))
            ]
            meta = self.associations(
                meta, iid, entries + [(index, kind in ("hvcC", "auxC", "irot", "imir"))]
            )
        return meta

    def copy_properties(self, meta, iid, source, discovery, source_id, uri=None):
        p = self.p
        entries = []
        for a in discovery["props"]["associations"].get(source_id, []):
            prop = discovery["props"]["properties"][a["index"] - 1]
            off, size, _, _ = prop["box"]
            blob = source[off : off + size]
            if uri and prop["type"] == "auxC":
                blob = p._auxc_box(uri)
            props = p.parse_ipco_ipma(meta)
            index = next(
                (
                    x["index"]
                    for x in props["properties"]
                    if meta[x["box"][0] : x["box"][0] + x["box"][1]] == blob
                ),
                None,
            )
            if index is None:
                meta, index = p.append_ipco_property(meta, blob)
            entries.append((index, a["essential"]))
        return self.associations(meta, iid, entries)

    def grid(self, meta, iid, width, height, columns, rows):
        p = self.p
        iloc = p.parse_iloc(meta)
        item = iloc["items"][iid]
        if item["construction_method"] != 1 or len(item["extents"]) != 1:
            raise p.PortError("Grid descriptor must live in idat")
        box = p.find_child(p.meta_children(meta, p.top_box(meta, "meta")), "idat")
        extent = item["extents"][0]
        off = box[0] + box[2] + item["base_offset"] + extent["offset"]
        length = extent["length"]
        if not (
            0 < width <= 65535
            and 0 < height <= 65535
            and 0 < columns <= 256
            and 0 < rows <= 256
        ):
            raise p.PortError("Grid exceeds v0 descriptor capacity")
        descriptor = bytes([0, 0, rows - 1, columns - 1]) + struct.pack(
            ">HH", width, height
        )
        if length != 8:
            raise p.PortError("Unsupported grid descriptor size")
        out = bytearray(meta)
        out[off : off + 8] = descriptor
        return self.property(bytes(out), [iid], "ispe", p._ispe_box(width, height))

    def copy_grid(self, meta, iid, data, d, source_id):
        p = self.p
        descriptor = p.extract_item(data, d["iloc"], source_id)
        if len(descriptor) < 8 or descriptor[0] != 0 or descriptor[1] & 1:
            raise p.PortError("Unsupported source grid descriptor")
        return self.grid(
            meta,
            iid,
            *p.dimensions_for_item(d["props"], source_id),
            descriptor[3] + 1,
            descriptor[2] + 1,
        )

    def replace_idat(self, meta, iid, blob):
        """Append an idat value and repoint its extent without shifting other descriptors."""
        p = self.p
        box = p.find_child(p.meta_children(meta, p.top_box(meta, "meta")), "idat")
        body = meta[box[0] + box[2] : box[0] + box[1]]
        meta = self.child(meta, "idat", p._box("idat", body + blob))
        iloc = p.parse_iloc(meta)
        item = iloc["items"][iid]
        if item["construction_method"] != 1 or len(item["extents"]) != 1:
            raise p.PortError("Expected an idat-backed descriptor")
        e = item["extents"][0]
        out = bytearray(meta)
        out[e["offset_pos"] : e["offset_pos"] + iloc["offset_size"]] = (
            len(body) - item["base_offset"]
        ).to_bytes(iloc["offset_size"], "big")
        out[e["length_pos"] : e["length_pos"] + iloc["length_size"]] = len(
            blob
        ).to_bytes(iloc["length_size"], "big")
        return bytes(out)

    def build(self, ftyp, meta, payloads):
        p = self.p
        iloc = p.parse_iloc(meta)
        out = bytearray(meta)
        cursor = len(ftyp) + len(meta) + 8
        chunks = []
        for iid, item in sorted(iloc["items"].items()):
            if item["construction_method"] != 0:
                continue
            if len(item["extents"]) != 1 or iid not in payloads:
                raise p.PortError(f"Missing or unsupported payload: {iid}")
            blob = payloads[iid]
            e = item["extents"][0]
            offset = cursor - item["base_offset"]
            length = len(blob)
            if offset >= 2 ** (8 * iloc["offset_size"]) or length >= 2 ** (
                8 * iloc["length_size"]
            ):
                raise p.PortError("File too large for iloc offsets")
            out[e["offset_pos"] : e["offset_pos"] + iloc["offset_size"]] = (
                offset.to_bytes(iloc["offset_size"], "big")
            )
            out[e["length_pos"] : e["length_pos"] + iloc["length_size"]] = (
                length.to_bytes(iloc["length_size"], "big")
            )
            chunks.append(blob)
            cursor += length
        result = ftyp + bytes(out) + p._box("mdat", b"".join(chunks))
        check = p.discover_heic(result)
        for iid, item in iloc["items"].items():
            if (
                item["construction_method"] == 0
                and p.extract_item(result, check["iloc"], iid) != payloads[iid]
            ):
                raise p.PortError(f"Self-check failed: item {iid}")
        return result

    def encoded_properties(self, meta, iid, value, primary=None, uri=None):
        p = self.p
        for kind, blob in [
            ("ispe", p._ispe_box(value["width"], value["height"])),
            ("pixi", value.get("pixi", p.MATTE_2026_PIXI)),
            ("hvcC", value["hvcc"]),
            ("colr", value.get("colr")),
        ]:
            meta = self.property(meta, [iid], kind, blob)
        if uri:
            meta = self.property(meta, [iid], "auxC", p._auxc_box(uri))
        if primary is not None:
            props = p.parse_ipco_ipma(meta)
            for kind in ("irot", "imir"):
                meta = self.property(
                    meta, [iid], kind, p.property_box_bytes(meta, props, primary, kind)
                )
        props = p.parse_ipco_ipma(meta)
        entries = props["associations"].get(iid, [])
        transforms = lambda a: (
            props["properties"][a["index"] - 1]["type"] in ("irot", "imir")
        )
        meta = self.associations(
            meta,
            iid,
            [(a["index"], a["essential"]) for a in entries if not transforms(a)]
            + [(a["index"], a["essential"]) for a in entries if transforms(a)],
        )
        return meta

    def skin_overrides(self, data, d, generated=None):
        p = self.p
        out = dict(generated or {})
        native_v2 = False
        for uri in [p.MATTE_URIS["semanticskinmatte"], p.MATTE_2026_URIS[1]]:
            iid = next(
                (i for i in d["infos"] if p.aux_uri_for_item(d["props"], i) == uri),
                None,
            )
            if iid is not None:
                out[uri] = dict(
                    source=data,
                    discovery=d,
                    item=iid,
                    payload=p.extract_item(data, d["iloc"], iid),
                )
                if uri == p.MATTE_2026_URIS[1]:
                    native_v2 = True
        legacy = out.get(p.MATTE_URIS["semanticskinmatte"])
        if legacy and "source" in legacy and not native_v2:
            out[p.MATTE_2026_URIS[1]] = legacy
        elif legacy is None and p.MATTE_2026_URIS[1] in out:
            out[p.MATTE_URIS["semanticskinmatte"]] = out[p.MATTE_2026_URIS[1]]
        return out

    def auxiliaries(self, meta, payloads, primary, overrides):
        p = self.p
        infos = p.parse_iinf(meta)
        props = p.parse_ipco_ipma(meta)
        for uri, value in overrides.items():
            values = value.get("instances", [value])
            for replacement in values:
                iid = (
                    None
                    if "instances" in value
                    else next(
                        (i for i in infos if p.aux_uri_for_item(props, i) == uri), None
                    )
                )
                if iid is None:
                    meta, assigned = p.add_items(
                        meta,
                        [
                            dict(
                                key="aux",
                                item_type="hvc1",
                                ref_type="auxl",
                                ref_to=[primary]
                                + p.find_items_by_type(p.parse_iinf(meta), "tmap")[:1],
                            )
                        ],
                    )
                    iid = assigned["aux"]
                    key = replacement.get("referenceKey")
                    xmp = (
                        '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:fsincMattes="http://ns.apple.com/fsinc/1.0/"><fsincMattes:FSINCMatteVersion>0</fsincMattes:FSINCMatteVersion>'
                        + (
                            f"<fsincMattes:InstanceMaskReferenceKey>{key}</fsincMattes:InstanceMaskReferenceKey>"
                            if key
                            else ""
                        )
                        + "</rdf:Description></rdf:RDF></x:xmpmeta>"
                    ).encode()
                    if uri == p.MATTE_URIS["semanticskinmatte"]:
                        xmp = (
                            '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
                            '<rdf:Description xmlns:semanticSegmentationMatte="http://ns.apple.com/semanticSegmentationMatte/1.0/">'
                            "<semanticSegmentationMatte:SemanticSegmentationMatteVersion>65536</semanticSegmentationMatte:SemanticSegmentationMatteVersion>"
                            "</rdf:Description></rdf:RDF></x:xmpmeta>"
                        ).encode()
                    meta, side = p.add_items(
                        meta,
                        [
                            dict(
                                key="xmp",
                                item_type="mime",
                                content_type="application/rdf+xml",
                                ref_type="cdsc",
                                ref_to=[iid],
                            )
                        ],
                    )
                    payloads[side["xmp"]] = xmp
                if "source" in replacement:
                    meta = self.copy_properties(
                        meta,
                        iid,
                        replacement["source"],
                        replacement["discovery"],
                        replacement["item"],
                        uri,
                    )
                else:
                    meta = self.encoded_properties(meta, iid, replacement, primary, uri)
                payloads[iid] = replacement["payload"]
                meta = p.set_item_reference(
                    meta,
                    "auxl",
                    iid,
                    [primary] + p.find_items_by_type(p.parse_iinf(meta), "tmap")[:1],
                )
                infos = p.parse_iinf(meta)
                props = p.parse_ipco_ipma(meta)
        return meta

    def portrait(self, meta, payloads, primary, data, d, generated):
        p = self.p
        uri = p.MATTE_URIS["portraiteffectsmatte"]
        native = next(
            (i for i in d["infos"] if p.aux_uri_for_item(d["props"], i) == uri), None
        )
        if native is not None:
            value = dict(
                source=data,
                discovery=d,
                item=native,
                payload=p.extract_item(data, d["iloc"], native),
            )
            mode = "native-preserved"
        else:
            value = generated
            mode = "target-person-segmentation" if value else "omitted-unavailable"
        if value:
            meta = self.auxiliaries(meta, payloads, primary, {uri: value})
        else:
            props = p.parse_ipco_ipma(meta)
            removed = {
                i for i in p.parse_iinf(meta) if p.aux_uri_for_item(props, i) == uri
            }
            for r in p.parse_iref(meta):
                if r["type"] == "cdsc" and r["to"] and set(r["to"]) <= removed:
                    removed.add(r["from"])
            meta = p.remove_items(meta, removed)
            for iid in removed:
                payloads.pop(iid, None)
        return meta, dict(mode=mode, donorPlaceholderUsed=False, sourceItemId=native)

    def person_metadata(self, styles, metadata):
        if not metadata:
            return styles
        pl = plistlib.loads(styles)
        if isinstance(pl.get("7"), dict):
            pl["7"].update(
                PersonMasksValidHint=1.0,
                PeopleRatio=metadata["peopleRatio"],
                SkinRatio=metadata["skinRatio"],
            )
        for key, value in metadata.get("blocks", {}).items():
            if key in pl.get("6", {}):
                pl["6"][key] = value
        return plistlib.dumps(pl, fmt=plistlib.FMT_BINARY, sort_keys=False)

    def profile(self, d, path=None):
        p = self.p
        if path:
            return (*p.load_profile(Path(path)), str(path))
        count = len(d["primary_tiles"])
        hdr = len(d["hdr_tiles"])
        direct = d["hdr_grid"] is not None and not hdr
        if not count or d["exif_item"] is None:
            raise p.PortError(
                "Compatibility re-encoding required for this primary/Exif layout"
            )
        candidates = [
            (name, info)
            for name, info in p.BUILTIN_PROFILE_INFO.items()
            if info["primary_tiles"] >= count
            and (direct or d["hdr_grid"] is None or info["hdr_tiles"] == hdr)
        ]
        if not candidates:
            raise p.PortError(
                f"No safe profile graft for {count}/{hdr}; compatibility re-encoding required"
            )
        name = (
            "48-12"
            if (direct or d["hdr_grid"] is None)
            else min(candidates, key=lambda pair: pair[1]["primary_tiles"])[0]
        )
        return (*p.load_profile(p.builtin_profile_bytes(name)), f"builtin:{name}")

    def patch(
        self,
        data,
        profile,
        linear,
        faces=None,
        synthetic_hdr=None,
        scene_mode="donor",
        sorted_luma=None,
        light_maps=None,
    ):
        p = self.p
        d = p.discover_heic(data)
        manifest, ftyp, meta, retained, mn54, label = profile
        payloads = dict(retained)
        primary = int(manifest["donor_primary_item"])
        faces = faces or {}
        overrides = self.skin_overrides(data, d, faces.get("overrides"))
        source_tiles = d["primary_tiles"]
        slots = list(map(int, manifest["donor_primary_tiles"]))
        if not (1 <= len(source_tiles) <= len(slots)):
            raise p.PortError("Primary tile count exceeds donor capacity")
        unused = slots[len(source_tiles) :]
        meta = p.remove_items(meta, unused)
        for iid in unused:
            payloads.pop(iid, None)
        used = slots[: len(source_tiles)]
        meta = p.set_item_reference(meta, "dimg", primary, used)
        meta = self.copy_grid(meta, primary, data, d, d["primary"])
        meta = self.copy_properties(meta, primary, data, d, d["primary"])
        for out, source in zip(used, source_tiles):
            payloads[out] = p.extract_item(data, d["iloc"], source)
            meta = self.copy_properties(meta, out, data, d, source)
        hdr = int(manifest["donor_hdr_grid_item"])
        hdr_slots = list(map(int, manifest["donor_hdr_tiles"]))
        source_hdr = d["hdr_grid"]
        if d["hdr_tiles"]:
            if len(d["hdr_tiles"]) != len(hdr_slots):
                raise p.PortError("Unmatched tiled HDR graph")
            meta = self.copy_grid(meta, hdr, data, d, source_hdr)
            meta = self.copy_properties(meta, hdr, data, d, source_hdr)
            for out, source in zip(hdr_slots, d["hdr_tiles"]):
                payloads[out] = p.extract_item(data, d["iloc"], source)
                meta = self.copy_properties(meta, out, data, d, source)
            hdr_mode = "tiled-preserved"
        else:
            removed = {hdr, *hdr_slots}
            sidecars = []
            for ref in p.parse_iref(meta):
                if ref["type"] == "cdsc" and set(ref["to"]) & removed:
                    if ref["from"] in payloads:
                        sidecars.append(payloads[ref["from"]])
                    removed.add(ref["from"])
            meta = p.remove_items(meta, removed)
            for iid in removed:
                payloads.pop(iid, None)
            meta, assigned = p.add_items(
                meta,
                [dict(key="hdr", item_type="hvc1", ref_type="auxl", ref_to=[primary])],
            )
            hdr = assigned["hdr"]
            if source_hdr is not None:
                payloads[hdr] = p.extract_item(data, d["iloc"], source_hdr)
                meta = self.copy_properties(meta, hdr, data, d, source_hdr)
                hdr_mode = "direct"
            else:
                if not synthetic_hdr:
                    raise p.PortError("Missing generated HDR gain map")
                payloads[hdr] = synthetic_hdr["payload"]
                meta = self.encoded_properties(
                    meta,
                    hdr,
                    synthetic_hdr,
                    primary,
                    "urn:com:apple:photo:2020:aux:hdrgainmap",
                )
                hdr_mode = "synthetic-direct"
                for blob in sidecars:
                    meta, assigned = p.add_items(
                        meta,
                        [
                            dict(
                                key="hdr-xmp",
                                item_type="mime",
                                content_type="application/rdf+xml",
                                ref_type="cdsc",
                                ref_to=[hdr],
                            )
                        ],
                    )
                    payloads[assigned["hdr-xmp"]] = blob
        tmaps = p.find_items_by_type(p.parse_iinf(meta), "tmap")
        source_tmaps = p.find_items_by_type(d["infos"], "tmap")
        paired_tmap = None
        if tmaps:
            tmap = tmaps[0]
            meta = p.set_item_reference(meta, "dimg", tmap, [primary, hdr])
            w, h = p.dimensions_for_item(d["props"], d["primary"])
            angle = p.irot_angle_for_item(data, d["props"], d["primary"])
            dw, dh = p.display_dimensions(w, h, angle)
            meta = self.property(meta, [tmap], "ispe", p._ispe_box(dw, dh))
            meta = self.property(meta, [tmap], "irot", p.IROT_IDENTITY)
            meta = self.property(
                meta,
                [tmap],
                "colr",
                p.property_box_bytes(data, d["props"], d["primary"], "colr"),
            )
            paired_tmap = next(
                (
                    i
                    for i in source_tmaps
                    if any(
                        r["type"] == "dimg"
                        and r["from"] == i
                        and r["to"] == [d["primary"], source_hdr]
                        for r in d["refs"]
                    )
                ),
                None,
            )
            if paired_tmap is not None:
                meta = self.replace_idat(
                    meta, tmap, p.extract_item(data, d["iloc"], paired_tmap)
                )
                meta = self.copy_properties(meta, tmap, data, d, paired_tmap)
        if source_hdr is not None:
            infos = p.parse_iinf(meta)
            related = {hdr, *tmaps}
            stale = {
                r["from"]
                for r in p.parse_iref(meta)
                if r["type"] == "cdsc"
                and infos[r["from"]]["type"] == "mime"
                and related.intersection(r["to"])
            }
            meta = p.remove_items(meta, stale)
            for iid in stale:
                payloads.pop(iid, None)
        thumb = int(manifest["donor_thumbnail_item"])
        payloads[thumb] = p.extract_item(data, d["iloc"], d["thumbnail"])
        meta = self.copy_properties(meta, thumb, data, d, d["thumbnail"])
        exif = int(manifest["donor_exif_item"])
        payloads[exif] = p.inject_apple_makernote_tag(
            p.extract_item(data, d["iloc"], d["exif_item"]),
            mn54,
            0x54,
            int(manifest.get("smartstyle_makernote_type", 7)),
        )
        delta = int(manifest["donor_delta_grid_item"])
        delta_slots = list(map(int, manifest["donor_delta_tiles"]))
        w, h = p.dimensions_for_item(d["props"], d["primary"])
        scale = (
            min(1, 2880 / w, 2160 / h)
            if faces.get("raster")
            else min((2880 if w >= h else 2160) / w, (2160 if w >= h else 2880) / h)
        )
        dw, dh = [max(2, int(math.floor(n * scale / 2 + 0.5)) * 2) for n in (w, h)]
        columns, rows = math.ceil(dw / 512), math.ceil(dh / 512)
        needed = columns * rows
        if needed > len(delta_slots):
            raise p.PortError("Neutral delta grid exceeds donor capacity")
        unused = delta_slots[needed:]
        meta = p.remove_items(meta, unused)
        for iid in unused:
            payloads.pop(iid, None)
        meta = p.set_item_reference(meta, "dimg", delta, delta_slots[:needed])
        meta = self.grid(meta, delta, dw, dh, columns, rows)
        for kind in ("irot", "imir"):
            meta = self.property(
                meta,
                [delta],
                kind,
                p.property_box_bytes(data, d["props"], d["primary"], kind)
                or (p.IROT_IDENTITY if kind == "irot" else None),
            )
        # Carry every native semantic/depth item with its own codec, geometry and transforms.
        mapped = {d["primary"]: primary}
        if source_hdr is not None:
            mapped[source_hdr] = hdr
        if tmaps and source_tmaps:
            mapped[source_tmaps[0]] = tmaps[0]
        # Neutralize unmatched legacy masks when the target carries a native matte set.
        native_legacy = {p.aux_uri_for_item(d["props"], i) for i in d["infos"]} & set(
            p.MATTE_URIS.values()
        )
        if native_legacy:
            donor_props = p.parse_ipco_ipma(meta)
            neutral = next(
                (
                    i
                    for i in p.parse_iinf(meta)
                    if p.aux_uri_for_item(donor_props, i)
                    == p.MATTE_URIS["portraiteffectsmatte"]
                ),
                None,
            )
            if neutral is not None:
                original = meta
                for iid in p.parse_iinf(meta):
                    uri = p.aux_uri_for_item(donor_props, iid)
                    if uri in p.MATTE_URIS.values() and uri not in native_legacy:
                        payloads[iid] = payloads[neutral]
                        meta = self.copy_properties(
                            meta, iid, original, {"props": donor_props}, neutral, uri
                        )
        for uri_id in d["infos"]:
            uri = p.aux_uri_for_item(d["props"], uri_id)
            if (
                uri in p.MATTE_URIS.values()
                or uri in p.MATTE_2026_URIS
                or uri == p.DEPTH_URI
            ):
                replacement = dict(
                    source=data,
                    discovery=d,
                    item=uri_id,
                    payload=p.extract_item(data, d["iloc"], uri_id),
                )
                meta = self.auxiliaries(meta, payloads, primary, {uri: replacement})
                current = p.parse_ipco_ipma(meta)
                mapped[uri_id] = next(
                    i
                    for i in p.parse_iinf(meta)
                    if p.aux_uri_for_item(current, i) == uri
                )
        for ref in d["refs"]:
            if (
                ref["type"] == "cdsc"
                and ref["to"]
                and all(i in mapped for i in ref["to"])
                and d["infos"][ref["from"]]["type"] == "mime"
            ):
                meta, assigned = p.add_items(
                    meta,
                    [
                        dict(
                            key="source-xmp",
                            item_type="mime",
                            content_type=d["infos"][ref["from"]].get("content_type")
                            or "application/rdf+xml",
                            ref_type="cdsc",
                            ref_to=[mapped[i] for i in ref["to"]],
                        )
                    ],
                )
                payloads[assigned["source-xmp"]] = p.extract_item(
                    data, d["iloc"], ref["from"]
                )
        if faces.get("texture", "on") == "on":
            meta, texture_payloads, summary = p.add_texture_items(meta, primary)
            payloads.update(texture_payloads)
            if faces.get("texturePeopleData"):
                iid = next(
                    i
                    for i, info in p.parse_iinf(meta).items()
                    if info.get("uri") == p.URI_TEXTURE_STYLES
                )
                pl = plistlib.loads(payloads[iid])
                pl["TextureStylePostProcessedPeopleData"] = faces["texturePeopleData"]
                payloads[iid] = plistlib.dumps(
                    pl, fmt=plistlib.FMT_BINARY, sort_keys=False
                )
        else:
            summary = "off"
        native_uris = {p.aux_uri_for_item(d["props"], iid) for iid in d["infos"]}
        overrides = {
            uri: value
            for uri, value in overrides.items()
            if uri not in native_uris
            or "source" in value
            or uri == p.MATTE_URIS["semanticskinmatte"]
        }
        meta = self.auxiliaries(meta, payloads, primary, overrides)
        meta, portrait_report = self.portrait(
            meta,
            payloads,
            primary,
            data,
            d,
            overrides.get(p.MATTE_URIS["portraiteffectsmatte"]),
        )
        styles = int(manifest["donor_styles_item"])
        blob, stats = p.apply_scene_statistics(
            payloads[styles], scene_mode, sorted_luma
        )
        if light_maps:
            blob, _ = p.apply_light_maps(blob, *light_maps)
        blob = self.person_metadata(blob, faces.get("personMetadata"))
        if any(uri in overrides for uri in p.MATTE_URIS.values()):
            blob, _ = p.set_person_masks_valid(blob)
        if faces.get("texture", "on") == "on":
            blob, _ = p.upgrade_styles_v16(blob)
        payloads[styles] = blob
        lt = int(manifest["donor_linear_thumb_item"])
        payloads[lt] = linear["payload"]
        meta = self.encoded_properties(meta, lt, linear, primary)
        result = self.build(ftyp, meta, payloads)
        out = p.discover_heic(result)
        pairs = [
            (d["primary"], out["primary"]),
            *zip(source_tiles, out["primary_tiles"]),
        ]
        if source_hdr is not None:
            pairs.append((source_hdr, out["hdr_grid"]))
            pairs.extend(zip(d["hdr_tiles"], out["hdr_tiles"]))
        if paired_tmap is not None:
            pairs.append((paired_tmap, tmaps[0]))
        for before, after in pairs:
            if p.extract_item(data, d["iloc"], before) != p.extract_item(
                result, out["iloc"], after
            ):
                raise p.PortError("Self-check failed: primary/HDR payload changed")
            if self.render_properties(data, d, before) != self.render_properties(
                result, out, after
            ):
                raise p.PortError(
                    "Self-check failed: primary/HDR rendering properties changed"
                )
        report = dict(
            tool_version=p.VERSION,
            profile=label,
            target_primary_tiles=len(source_tiles),
            target_hdr_tiles=len(d["hdr_tiles"]),
            target_hdr_mode=hdr_mode,
            primary_payloads_preserved=True,
            hdr_payloads_preserved=source_hdr is not None,
            tmap_metadata="target-preserved"
            if paired_tmap is not None
            else "donor-default",
            portraitMatte=portrait_report,
            faces=dict(
                state=faces.get("state", "skipped"),
                count=faces.get("faces", 0),
                error=faces.get("error"),
            ),
            linear_thumb_mode=linear.get("mode", "generate"),
            linearthumb_size=[linear["width"], linear["height"]],
            linearthumb_bit_depth=linear.get("bitDepth", 10),
            texture_styles=summary,
            **stats,
        )
        return result, report

    def render_properties(self, data, d, iid):
        return [
            (a["essential"], data[prop["box"][0] : prop["box"][0] + prop["box"][1]])
            for a in d["props"]["associations"].get(iid, [])
            for prop in [d["props"]["properties"][a["index"] - 1]]
        ]

    def infer(self, decoded, work, args, angle=0, mirror=None, portrait_only=False):
        if (
            portrait_only
            and args.portrait_matte == "off"
            or not portrait_only
            and args.faces == "off"
        ):
            return dict(state="skipped", overrides={})
        try:
            from photographic_style_vision import generate_mattes

            return generate_mattes(
                decoded, work, args.model_dir, angle, mirror, portrait_only, port=self.p
            )
        except Exception as error:
            return dict(state="unavailable", error=str(error), overrides={})

    def sdr_colr(self):
        return self.p._box("colr", b"nclx" + struct.pack(">HHH", 1, 13, 1) + b"\0")

    def raster_exif(self, image, source, mn54, maker_type, width, height):
        p = self.p
        maker = (
            b"Apple iOS\0\0\1MM"
            + struct.pack(">H", 1)
            + struct.pack(">HHII", 0x54, maker_type, len(mn54), 32)
            + b"\0" * 4
            + mn54
        )
        # Preserve the original TIFF bytes and all value/GPS offsets, appending only new IFDs.
        if source:
            tiff = bytearray(source[6:] if source.startswith(b"Exif\0\0") else source)
        else:
            tiff = bytearray(b"MM\0*\0\0\0\10\0\0\0\0\0\0")
        if len(tiff) < 8 or tiff[:2] not in (b"II", b"MM"):
            raise p.PortError("Invalid raster EXIF TIFF header")
        order = "little" if tiff[:2] == b"II" else "big"
        read = lambda data, off, n: int.from_bytes(data[off : off + n], order)
        if read(tiff, 2, 2) != 42:
            raise p.PortError("Unsupported raster EXIF TIFF format")

        def table(off):
            if off < 8 or off + 2 > len(tiff):
                raise p.PortError("Invalid raster EXIF IFD offset")
            count = read(tiff, off, 2)
            end = off + 2 + 12 * count
            if end + 4 > len(tiff):
                raise p.PortError("Truncated raster EXIF IFD")
            result = {}
            for pos in range(off + 2, end, 12):
                raw = bytes(tiff[pos : pos + 12])
                tag = read(raw, 0, 2)
                size = p.TIFF_TYPE_SIZES.get(read(raw, 2, 2), 0) * read(raw, 4, 4)
                if not size or size > 4 and read(raw, 8, 4) + size > len(tiff):
                    raise p.PortError("Invalid raster EXIF value")
                if tag in result:
                    raise p.PortError("Duplicate raster EXIF tag")
                result[tag] = raw
            return result

        root = table(read(tiff, 4, 4))
        exif = table(read(root[0x8769], 8, 4)) if 0x8769 in root else {}

        def entry(tag, kind, count, value):
            return (
                tag.to_bytes(2, order)
                + kind.to_bytes(2, order)
                + count.to_bytes(4, order)
                + value.to_bytes(2 if kind == 3 else 4, order)
                + (b"\0\0" if kind == 3 else b"")
            )

        def append(blob):
            if len(tiff) & 1:
                tiff.append(0)
            off = len(tiff)
            tiff.extend(blob)
            return off

        # An existing Apple MakerNote is surgically updated; other makers stay in the untouched area.
        native = False
        if 0x927C in exif:
            raw = exif[0x927C]
            off = read(raw, 8, 4)
            read(raw, 4, 4)
            native = tiff[off : off + 9] == b"Apple iOS"
            if native:
                wrapped = b"\0\0\0\6Exif\0\0" + bytes(tiff)
                updated = p.inject_apple_makernote_tag(wrapped, mn54, 0x54, maker_type)
                tiff = bytearray(updated[10:])
                root = table(read(tiff, 4, 4))
                exif = table(read(root[0x8769], 8, 4))
        if not native:
            exif[0x927C] = entry(0x927C, 7, len(maker), append(maker))
        root[0x112] = entry(0x112, 3, 1, 6)
        for value, root_tag, exif_tag in [
            (width, 0x100, 0xA002),
            (height, 0x101, 0xA003),
        ]:
            if root_tag in root:
                root[root_tag] = entry(root_tag, 4, 1, value)
            exif[exif_tag] = entry(exif_tag, 4, 1, value)

        def ifd(entries):
            return (
                len(entries).to_bytes(2, order)
                + b"".join(value for _, value in sorted(entries.items()))
                + b"\0" * 4
            )

        exif_off = append(ifd(exif))
        root[0x8769] = entry(0x8769, 4, 1, exif_off)
        root_off = append(ifd(root))
        tiff[4:8] = root_off.to_bytes(4, order)
        return b"\0\0\0\6Exif\0\0" + bytes(tiff)

    def raster_source(self, raw, work, source_data=None, source_discovery=None):
        from PIL import Image, ImageCms, ImageOps

        p = self.p
        try:
            opened = Image.open(io.BytesIO(raw))
            exif = opened.info.get("exif")
            icc = opened.info.get("icc_profile")
            image = ImageOps.exif_transpose(opened)
            alpha = (
                image.convert("RGBA").getchannel("A")
                if image.mode in ("RGBA", "LA") or "transparency" in image.info
                else None
            )
            if icc:
                image = ImageCms.profileToProfile(
                    image.convert("RGB"),
                    ImageCms.ImageCmsProfile(io.BytesIO(icc)),
                    ImageCms.createProfile("sRGB"),
                    outputMode="RGB",
                )
            else:
                image = image.convert("RGB")
            if alpha is not None:
                background = Image.new("RGB", image.size)
                background.paste(image, mask=alpha)
                image = background
        except Exception as error:
            raise p.PortError(f"Raster image decode failed: {error}") from error
        # Match the Web tile budget without upscaling small images.
        width, height = image.size
        if math.ceil(width / 512) * math.ceil(height / 512) > 48:
            scale = max(
                min(columns * 512 / width, (48 // columns) * 512 / height, 1)
                for columns in range(1, 49)
            )
            width, height = (
                max(1, math.floor(width * scale)),
                max(1, math.floor(height * scale)),
            )
        image = image.resize((width, height), Image.Resampling.LANCZOS)
        decoded = work / "raster.png"
        image.save(decoded)
        stored = image.transpose(Image.Transpose.ROTATE_90)
        sw, sh = stored.size
        columns, rows = math.ceil(sw / 512), math.ceil(sh / 512)
        manifest, ftyp, meta, retained, mn54 = p.load_profile(
            p.builtin_profile_bytes("48-12")
        )
        payloads = {}
        primary = int(manifest["donor_primary_item"])
        slots = list(map(int, manifest["donor_primary_tiles"]))
        used = slots[: columns * rows]
        thumb = int(manifest["donor_thumbnail_item"])
        exif_id = int(manifest["donor_exif_item"])
        infos = p.parse_iinf(meta)
        keep = {primary, thumb, exif_id, *used}
        meta = p.remove_items(meta, set(infos) - keep)
        meta = p.set_item_reference(meta, "dimg", primary, used)
        meta = self.grid(meta, primary, sw, sh, columns, rows)
        pixi = p._box("pixi", b"\0" * 4 + bytes([3, 8, 8, 8]))
        colour = self.sdr_colr()
        for i, iid in enumerate(used):
            tile = Image.new("RGB", (512, 512))
            tile.paste(
                stored.crop(
                    (
                        (i % columns) * 512,
                        (i // columns) * 512,
                        (i % columns + 1) * 512,
                        (i // columns + 1) * 512,
                    )
                )
            )
            path = work / f"tile-{i}.png"
            tile.save(path)
            hvcc, payload, _ = p.encode_hevc_still(
                path, work, 512, 512, name=f"tile-{i}"
            )
            payloads[iid] = payload
            meta = self.encoded_properties(
                meta,
                iid,
                dict(width=512, height=512, hvcc=hvcc, pixi=pixi, colr=colour),
            )
        meta = self.property(meta, [primary], "colr", colour)
        scale = min(416 / sw, 312 / sh)
        tw, th = [max(2, int(math.floor(n * scale / 2 + 0.5)) * 2) for n in (sw, sh)]
        path = work / "raster-thumb.png"
        stored.resize((tw, th), Image.Resampling.LANCZOS).save(path)
        hvcc, payload, _ = p.encode_hevc_still(path, work, tw, th, name="raster-thumb")
        payloads[thumb] = payload
        meta = self.encoded_properties(
            meta,
            thumb,
            dict(width=tw, height=th, hvcc=hvcc, pixi=pixi, colr=colour),
            primary,
        )
        payloads[exif_id] = self.raster_exif(
            image, exif, mn54, int(manifest.get("smartstyle_makernote_type", 7)), sw, sh
        )
        if source_data is not None:
            # Preserve source-native skin, Portrait depth and blur XMP through compatibility re-encoding.
            overrides = self.skin_overrides(source_data, source_discovery)
            for iid in source_discovery["infos"]:
                uri = p.aux_uri_for_item(source_discovery["props"], iid)
                if uri in (p.DEPTH_URI, p.MATTE_URIS["portraiteffectsmatte"]):
                    overrides[uri] = dict(
                        source=source_data,
                        discovery=source_discovery,
                        item=iid,
                        payload=p.extract_item(
                            source_data, source_discovery["iloc"], iid
                        ),
                    )
            meta = self.auxiliaries(meta, payloads, primary, overrides)
            original_exif = (
                p.extract_item(
                    source_data, source_discovery["iloc"], source_discovery["exif_item"]
                )
                if source_discovery["exif_item"] is not None
                else None
            )
            if original_exif:
                start = 4 + int.from_bytes(original_exif[:4], "big")
                payloads[exif_id] = self.raster_exif(
                    image,
                    original_exif[start:],
                    mn54,
                    int(manifest.get("smartstyle_makernote_type", 7)),
                    sw,
                    sh,
                )
            for ref in source_discovery["refs"]:
                if ref["type"] != "cdsc" or not ref["to"]:
                    continue
                props = p.parse_ipco_ipma(meta)
                mapped = []
                for source_id in ref["to"]:
                    uri = p.aux_uri_for_item(source_discovery["props"], source_id)
                    target = (
                        primary
                        if source_id == source_discovery["primary"]
                        else next(
                            (
                                i
                                for i in p.parse_iinf(meta)
                                if uri and p.aux_uri_for_item(props, i) == uri
                            ),
                            None,
                        )
                    )
                    if target is None:
                        break
                    mapped.append(target)
                else:
                    meta, assigned = p.add_items(
                        meta,
                        [
                            dict(
                                key="native-xmp",
                                item_type="mime",
                                content_type="application/rdf+xml",
                                ref_type="cdsc",
                                ref_to=mapped,
                            )
                        ],
                    )
                    payloads[assigned["native-xmp"]] = p.extract_item(
                        source_data, source_discovery["iloc"], ref["from"]
                    )
        return self.build(ftyp, meta, payloads), decoded

    def add_thumbnail(self, data, d, decoded, work):
        p = self.p
        angle = p.irot_angle_for_item(data, d["props"], d["primary"])
        mirror = p.imir_axis_for_item(data, d["props"], d["primary"])
        w, h = p.dimensions_for_item(d["props"], d["primary"])
        scale = min(1, 416 / max(w, h))
        w, h = [max(2, int(math.floor(n * scale / 2 + 0.5)) * 2) for n in (w, h)]
        hvcc, payload, _ = p.encode_hevc_still(
            decoded, work, w, h, angle, mirror, name="missing-thumb"
        )
        meta = data[d["meta"][0] : d["meta"][0] + d["meta"][1]]
        meta, ids = p.add_items(
            meta,
            [
                dict(
                    key="thumb",
                    item_type="hvc1",
                    ref_type="thmb",
                    ref_to=[d["primary"]],
                )
            ],
        )
        iid = ids["thumb"]
        meta = self.encoded_properties(
            meta,
            iid,
            dict(
                width=w,
                height=h,
                hvcc=hvcc,
                pixi=p._box("pixi", b"\0" * 4 + bytes([3, 8, 8, 8])),
                colr=self.sdr_colr(),
            ),
            d["primary"],
        )
        payloads = {
            i: p.extract_item(data, d["iloc"], i)
            for i, it in d["iloc"]["items"].items()
            if it["construction_method"] == 0
        }
        payloads[iid] = payload
        off, size, _, _ = p.top_box(data, "ftyp")
        return self.build(data[off : off + size], meta, payloads)

    def run(self, args):
        p = self.p
        source = Path(args.target)
        raw = source.read_bytes()
        d = None
        imported = False
        with tempfile.TemporaryDirectory(
            prefix="photographic-style-port-"
        ) as directory:
            work = Path(directory)
            decoded = None
            if (
                raw[:8].startswith(b"\x89PNG")
                or raw[:2] == b"\xff\xd8"
                or raw[:4] == b"RIFF"
                and raw[8:12] == b"WEBP"
            ):
                raw, decoded = self.raster_source(raw, work)
                imported = True
            else:
                d = p.discover_heic(raw)
                if d["styles_item"] is None:
                    try:
                        selected = self.profile(d, args.profile)
                        p.inject_apple_makernote_tag(
                            p.extract_item(raw, d["iloc"], d["exif_item"]),
                            selected[4],
                            0x54,
                            int(selected[0].get("smartstyle_makernote_type", 7)),
                        )
                    except p.PortError:
                        decoded = p.decode_target_primary(source, work)
                        raw, decoded = self.raster_source(
                            decoded.read_bytes(),
                            work,
                            source_data=raw,
                            source_discovery=d,
                        )
                        imported = True
                if any(
                    i.get("uri") == p.URI_TEXTURE_STYLES for i in d["infos"].values()
                ):
                    raise p.PortError(
                        "Input already carries texture_styles (Texture/Grain is already offered)"
                    )
                if decoded is None and (
                    args.faces != "off"
                    or args.portrait_matte != "off"
                    or d["styles_item"] is None
                    and (
                        args.linear_thumb == "generate"
                        or args.scene_stats in ("target", "tone-only")
                        or args.light_maps == "target"
                        or d["thumbnail"] is None
                    )
                ):
                    decoded = p.decode_target_primary(source, work)
            d = p.discover_heic(raw)
            angle = p.irot_angle_for_item(raw, d["props"], d["primary"])
            mirror = p.imir_axis_for_item(raw, d["props"], d["primary"])
            faces = (
                self.infer(decoded, work, args, angle, mirror)
                if decoded and args.faces != "off"
                else dict(state="skipped", overrides={})
            )
            portrait_uri = p.MATTE_URIS["portraiteffectsmatte"]
            native_portrait = any(
                p.aux_uri_for_item(d["props"], i) == portrait_uri for i in d["infos"]
            )
            if (
                decoded
                and not native_portrait
                and portrait_uri not in faces.get("overrides", {})
                and args.portrait_matte != "off"
            ):
                portrait = self.infer(decoded, work, args, angle, mirror, True)
                faces.setdefault("overrides", {}).update(portrait.get("overrides", {}))
                if portrait.get("error"):
                    faces["error"] = portrait["error"]
            faces["texture"] = args.texture
            faces["raster"] = imported
            if args.portrait_matte == "off":
                faces.get("overrides", {}).pop(portrait_uri, None)
            if d["styles_item"] is not None:
                if args.texture == "off":
                    raise p.PortError(
                        "Native styles already present; nothing to do with --texture off"
                    )
                result, report = p.add_texture_bytes(
                    raw,
                    faces.get("overrides"),
                    faces.get("texturePeopleData"),
                    faces.get("personMetadata"),
                )
                report["faces"] = dict(
                    state=faces["state"],
                    count=faces.get("faces", 0),
                    error=faces.get("error"),
                )
            else:
                if d["thumbnail"] is None:
                    raw = self.add_thumbnail(raw, d, decoded, work)
                    d = p.discover_heic(raw)
                profile = self.profile(d, args.profile)
                synthetic = None
                if d["hdr_grid"] is None:
                    from PIL import Image

                    width, height = p.dimensions_for_item(d["props"], d["primary"])
                    width = max(2, round(width / 2 / 2) * 2)
                    height = max(2, round(height / 2 / 2) * 2)
                    path = work / "neutral-hdr.png"
                    Image.new("RGB", (width, height)).save(path)
                    hvcc, payload, _ = p.encode_hevc_still(
                        path, work, width, height, name="neutral-hdr"
                    )
                    synthetic = dict(
                        payload=payload,
                        hvcc=hvcc,
                        width=width,
                        height=height,
                        pixi=p._box("pixi", b"\0" * 4 + bytes([3, 8, 8, 8])),
                        colr=self.sdr_colr(),
                    )
                if args.linear_thumb == "generate":
                    w, h = p.dimensions_for_item(d["props"], d["primary"])
                    scale = min(1, 1024 / max(w, h))
                    w, h = [
                        max(2, int(math.floor(n * scale / 2 + 0.5)) * 2) for n in (w, h)
                    ]
                    hvcc, payload, _ = p.encode_target_linear_thumbnail(
                        decoded, work, w, h, angle, mirror
                    )
                    linear = dict(
                        payload=payload,
                        hvcc=hvcc,
                        width=w,
                        height=h,
                        pixi=p._box("pixi", b"\0" * 4 + bytes([3, 10, 10, 10])),
                        colr=p._box(
                            "colr", b"nclx" + struct.pack(">HHH", 12, 8, 1) + b"\0"
                        ),
                        bitDepth=10,
                        mode="generate",
                    )
                else:
                    iid = d["thumbnail"]
                    w, h = p.dimensions_for_item(d["props"], iid)
                    linear = dict(
                        payload=p.extract_item(raw, d["iloc"], iid),
                        hvcc=p.property_box_bytes(raw, d["props"], iid, "hvcC"),
                        pixi=p.property_box_bytes(raw, d["props"], iid, "pixi"),
                        colr=p.property_box_bytes(raw, d["props"], iid, "colr"),
                        width=w,
                        height=h,
                        bitDepth=8,
                        mode="reuse-thumbnail",
                    )
                luma = (
                    p.target_luma_distributions(decoded)
                    if decoded and args.scene_stats in ("target", "tone-only")
                    else None
                )
                maps = (
                    p.target_light_maps(decoded, angle, mirror)
                    if decoded and args.light_maps == "target"
                    else None
                )
                result, report = self.patch(
                    raw, profile, linear, faces, synthetic, args.scene_stats, luma, maps
                )
            report.update(
                target=source.name,
                output=Path(args.output).name,
                output_sha256=p.sha256_bytes(result),
                compatibility_reencoded=imported,
            )
            if imported:
                report.update(
                    primary_payloads_preserved=False, hdr_payloads_preserved=False
                )
            output = Path(args.output)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(result)
            text = json.dumps(report, indent=2)
            if args.report:
                output.with_suffix(output.suffix + ".report.json").write_text(
                    text, encoding="utf8"
                )
            if args.zip:
                with zipfile.ZipFile(
                    output.with_suffix(".zip"), "w", compression=zipfile.ZIP_DEFLATED
                ) as archive:
                    archive.writestr(output.name, result)
                    archive.writestr(output.name + ".report.json", text)
            print(
                f"Created patched HEIC: {output}\n  SHA-256: {report['output_sha256']}"
            )
            print(f"  faces: {faces['state']} ({faces.get('faces', 0)})")
            if faces.get("error"):
                print(f"  WARNING: local segmentation unavailable: {faces['error']}")
            if report.get("portraitMatte", {}).get("mode") == "omitted-unavailable":
                print("  Portrait effect matte unavailable; donor placeholder omitted")
