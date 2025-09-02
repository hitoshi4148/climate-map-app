import json
from datetime import datetime
from pathlib import Path
import time
import requests
import csv

# 設定（広域 + 高解像度は非常に時間がかかります。まずは小さい範囲で検証推奨）
YEARS = [1992, 1993, 1994, 1995, 1996, 1997, 1998, 1999, 2000, 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024]
# 日本全国（概略）：沖縄〜北海道まで（国外は極力含めない範囲）
LAT_MIN, LAT_MAX = 24.0, 46.0
LON_MIN, LON_MAX = 123.0, 146.0
STEP = 0.5  # degrees
REQUEST_SLEEP_SEC = 0.5  # レート制御（POWER API配慮）
TIMEOUT_SEC = 30
CACHE_DIR = Path("cache/power_T2M")
VERBOSE = True
FAIL_LOG = Path("fetch_failures_kanto.csv")

POWER_BASE = "https://power.larc.nasa.gov/api/temporal/monthly/point"
POWER_PARAMS = {
    "parameters": "T2M",
    "community": "SB",
    "format": "JSON",
}


def fetch_power_t2m(lat: float, lon: float, start_year: int, end_year: int):
    """NASA POWER APIから指定点の月平均気温(T2M)を取得。キャッシュ使用。"""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = CACHE_DIR / f"T2M_{lat:.1f}_{lon:.1f}_{start_year}_{end_year}.json"
    if cache_file.exists():
        try:
            data = json.loads(cache_file.read_text(encoding="utf-8"))
            if VERBOSE:
                print(f"CACHE HIT lat={lat:.1f} lon={lon:.1f}")
            return data
        except Exception:
            pass

    params = {
        **POWER_PARAMS,
        "longitude": lon,
        "latitude": lat,
        "start": start_year,
        "end": end_year,
    }
    url = POWER_BASE
    try:
        r = requests.get(url, params=params, timeout=TIMEOUT_SEC, headers={"User-Agent": "climate-fetcher/1.0"})
        status = r.status_code
        if VERBOSE:
            print(f"FETCH lat={lat:.1f} lon={lon:.1f} status={status} url={r.url}")
        r.raise_for_status()
        data = r.json()
        cache_file.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        time.sleep(REQUEST_SLEEP_SEC)
        return data
    except Exception as e:
        if VERBOSE:
            print(f"ERROR FETCH lat={lat:.1f} lon={lon:.1f} err={e}")
        raise


def calculate_wi_from_monthly(monthly: dict) -> float:
    """月平均気温から温量指数（sum(max(T-5,0)))を算出。"""
    wi = 0.0
    for temp in monthly.values():
        if temp is not None and temp > 5.0:
            wi += (temp - 5.0)
    return round(wi, 1)


def process_yearly_from_power(power_json: dict) -> dict:
    """POWERレスポンスから年ごとのWIを作成。{year: wi} を返す。"""
    if not power_json or "properties" not in power_json or "parameter" not in power_json["properties"]:
        if VERBOSE:
            keys = list(power_json.keys()) if isinstance(power_json, dict) else type(power_json)
            print(f"INVALID JSON STRUCT keys={keys}")
        return {}
    t2m = power_json["properties"]["parameter"].get("T2M", {})
    by_year = {y: {} for y in YEARS}
    for ym, temp in t2m.items():
        try:
            y = int(ym[:4])
            m = int(ym[4:6])
        except Exception:
            continue
        if y in by_year:
            by_year[y][m] = temp
    wi_by_year = {}
    if VERBOSE:
        counts = {y: len(mdict) for y, mdict in by_year.items()}
        print(f"MONTHS COUNT {counts}")
    for y, months in by_year.items():
        if len(months) == 0:
            continue
        wi_by_year[y] = calculate_wi_from_monthly(months)
    return wi_by_year


def assign_zone(wi: float) -> str:
    if wi < 15:
        return "I"
    if wi < 45:
        return "II"
    if wi < 85:
        return "III"
    if wi < 180:
        return "IV"
    if wi < 240:
        return "V"
    return "VI"


def frange(start: float, stop: float, step: float):
    v = start
    eps = 1e-9
    while v <= stop + eps:
        yield round(v, 1)
        v = round(v + step, 10)


def generate_dataset():
    data_by_year = {str(y): [] for y in YEARS}
    lat_count = int(round((LAT_MAX - LAT_MIN) / STEP)) + 1
    lon_count = int(round((LON_MAX - LON_MIN) / STEP)) + 1
    total_points = lat_count * lon_count

    print(f"Target bbox: lat {LAT_MIN}..{LAT_MAX}, lon {LON_MIN}..{LON_MAX}, step {STEP}°")
    print(f"Years: {YEARS[0]}-{YEARS[-1]} | Total grid points: {total_points}")

    # 失敗・欠損のCSV準備
    with FAIL_LOG.open("w", newline="", encoding="utf-8") as fcsv:
        writer = csv.writer(fcsv)
        writer.writerow(["lat", "lon", "note"])  # ヘッダ

    processed = 0
    start_ts = time.time()
    last_persist_ts = start_ts

    for lat in frange(LAT_MIN, LAT_MAX, STEP):
        for lon in frange(LON_MIN, LON_MAX, STEP):
            note = None
            try:
                power = fetch_power_t2m(lat, lon, YEARS[0], YEARS[-1])
                wi_by_year = process_yearly_from_power(power)
                if len(wi_by_year) == 0:
                    note = "no_months"
                added_any = False
                for y in YEARS:
                    wi = wi_by_year.get(y)
                    if wi is None:
                        continue
                    zone = assign_zone(wi)
                    data_by_year[str(y)].append({
                        "lat": lat,
                        "lon": lon,
                        "wi": wi,
                        "zone": zone,
                    })
                    added_any = True
                if not added_any and note is None:
                    note = "no_valid_years"
            except Exception as e:
                note = f"error:{e.__class__.__name__}"
            if note:
                with FAIL_LOG.open("a", newline="", encoding="utf-8") as fcsv:
                    csv.writer(fcsv).writerow([lat, lon, note])

            processed += 1

            # 進行状況（ライブ1行更新）
            if processed % 50 == 0 or processed == total_points:
                elapsed = time.time() - start_ts
                rate = processed / elapsed if elapsed > 0 else 0.0
                remaining = total_points - processed
                eta = remaining / rate if rate > 0 else float("inf")
                percent = processed / total_points * 100.0
                print(
                    f"Progress: {processed}/{total_points} ({percent:5.1f}%)  "
                    f"elapsed {elapsed:6.1f}s  rate {rate:6.1f} pts/s  ETA {eta:6.1f}s",
                    end="\r",
                    flush=True,
                )

            # 定期的に改行して履歴を残す
            if time.time() - last_persist_ts > 30:
                print()  # newline
                last_persist_ts = time.time()

    print()  # 最終行の改行
    return {
        "metadata": {
            "test_mode": False,
            "resolution": STEP,
            "years_range": f"{YEARS[0]}-{YEARS[-1]}",
            "total_points": total_points,
            "generated_at": datetime.now().isoformat(),
            "region": "Japan_0.5deg",
            "wi_method": "sum(max(T_month-5,0)) using NASA POWER T2M (monthly)",
            "source": POWER_BASE,
            "fail_log": str(FAIL_LOG.resolve()),
        },
        "data": data_by_year,
    }


def main():
    out_path = Path("climate-map-app/public/climate-grid-0.1deg.json").resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    dataset = generate_dataset()
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(dataset, f, ensure_ascii=False, separators=(",", ":"))

    print(f"Written: {out_path}")
    print(f"Years: {dataset['metadata']['years_range']}  Resolution: {dataset['metadata']['resolution']}°  Points(year target): {dataset['metadata']['total_points']}")
    print(f"Fail log: {dataset['metadata']['fail_log']}")


if __name__ == "__main__":
    main()
