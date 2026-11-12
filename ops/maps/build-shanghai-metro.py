"""Bundle real Shanghai Metro routes/stops from an attributed OpenStreetMap snapshot (ODbL)."""
import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
ENDPOINT = "https://overpass-api.de/api/interpreter"
QUERY = ('[out:json][timeout:60];relation["network:en"="Shanghai Metro"]'
         '["type"="route"]["route"~"subway|light_rail"](30.65,120.85,31.9,122.2)->.r;'
         '(.r;node(r.r););out geom;')
LICENSE = "https://opendatacommons.org/licenses/odbl/1-0/"


def build(raw):
    if raw.get("remark"):
        raise ValueError("Overpass returned an incomplete response: " + raw["remark"])
    elements = raw["elements"]
    nodes = {item["id"]: item for item in elements if item["type"] == "node"}
    routes, stations = {}, []
    for relation in elements:
        tags = relation.get("tags", {})
        if (relation["type"] != "relation" or tags.get("network:en") != "Shanghai Metro"
                or tags.get("route") not in ("subway", "light_rail")
                or any(tags.get(key) for key in ("construction", "proposed", "disused"))):
            continue
        ref, color = tags.get("ref", ""), tags.get("colour", "")
        if not ref or not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
            raise ValueError(f"Missing line identity/color on relation {relation['id']}")
        line = routes.setdefault(ref, {"ref": ref, "name": f"{ref}号线" if ref.isdigit() else f"{ref}线",
                                       "color": color, "relations": [], "segments": {}})
        if line["color"].lower() != color.lower():
            raise ValueError(f"Conflicting route colors: {ref}")
        line["relations"].append(relation["id"])
        for member in relation.get("members", []):
            # Never draw platforms or connect disjoint ways with invented straight lines.
            if member["type"] == "way" and member.get("role", "") in ("", "forward", "backward"):
                geometry = member.get("geometry", [])
                if len(geometry) < 2 or any("lon" not in p or "lat" not in p for p in geometry):
                    raise ValueError(f"Incomplete way geometry: {member['ref']}")
                line["segments"][member["ref"]] = [[round(p["lon"], 6), round(p["lat"], 6)] for p in geometry]
            if member["type"] != "node" or member.get("role") not in ("stop", "stop_entry_only", "stop_exit_only"):
                continue
            node = nodes.get(member["ref"])
            name = (node or {}).get("tags", {}).get("name:zh") or (node or {}).get("tags", {}).get("name")
            if not node or not name:
                raise ValueError(f"Missing stop tags: {member['ref']}")
            point = [round(node["lon"], 6), round(node["lat"], 6)]
            station = next((s for s in stations if s["name"] == name
                            and abs(s["coordinate"][0] - point[0]) < 0.006
                            and abs(s["coordinate"][1] - point[1]) < 0.006), None)
            if station is None:
                station = {"name": name, "coordinate": point, "lines": set(), "nodes": set()}
                stations.append(station)
            station["lines"].add(ref)
            station["nodes"].add(node["id"])
    features = []
    ordered = sorted(routes.values(), key=lambda line: (not line["ref"].isdigit(), int(line["ref"]) if line["ref"].isdigit() else line["ref"]))
    for line in ordered:
        if not line["segments"]:
            raise ValueError(f"Empty route: {line['ref']}")
        features.append({"type": "Feature", "properties": {"kind": "route", **{key: line[key] for key in ("ref", "name", "color", "relations")}},
                         "geometry": {"type": "MultiLineString", "coordinates": list(line["segments"].values())}})
    for station in sorted(stations, key=lambda item: (item["name"], item["coordinate"])):
        features.append({"type": "Feature", "properties": {"kind": "station", "name": station["name"],
                         "lines": sorted(station["lines"]), "nodes": sorted(station["nodes"])},
                         "geometry": {"type": "Point", "coordinates": station["coordinate"]}})
    if len(ordered) < 18 or len(stations) < 400:
        raise ValueError("Incomplete Shanghai Metro snapshot")
    return {"type": "FeatureCollection", "license": LICENSE, "features": features}, ordered, stations


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / "runtime/maps/shanghai-metro-overpass.json")
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--output", type=Path, default=ROOT / "frontend/src/company/assets/shanghai-metro.geojson")
    args = parser.parse_args()
    if args.download:
        request = Request(ENDPOINT + "?" + urlencode({"data": QUERY}), headers={"User-Agent": "JDCollectorMap/1.0"})
        with urlopen(request, timeout=90) as response:
            content = response.read()
        raw = json.loads(content)
        build(raw)  # Validate before replacing the cached snapshot.
        args.source.parent.mkdir(parents=True, exist_ok=True)
        args.source.write_bytes(content)
    else:
        content = args.source.read_bytes()
        raw = json.loads(content)
    collection, routes, stations = build(raw)
    args.output.write_text(json.dumps(collection, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    metadata = {"source": ENDPOINT, "query": QUERY, "sourceTimestamp": raw.get("osm3s", {}).get("timestamp_osm_base"),
                "generatedAt": datetime.now(timezone.utc).isoformat(), "sourceSha256": hashlib.sha256(content).hexdigest(),
                "outputSha256": hashlib.sha256(args.output.read_bytes()).hexdigest(),
                "license": LICENSE, "attribution": "© OpenStreetMap contributors", "coordinateSystem": "WGS84",
                "lineCount": len(routes), "stationCount": len(stations),
                "lines": [{key: line[key] for key in ("ref", "name", "color", "relations")} for line in routes]}
    args.output.with_suffix(".metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Bundled {len(routes)} lines, {len(stations)} stations; {args.output.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
