import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Play, Pause, SkipBack, SkipForward } from 'lucide-react';
import { MapContainer, TileLayer, Polyline, Rectangle, Marker, useMap } from 'react-leaflet';
import L from 'leaflet';
import { contours } from 'd3-contour';

// Zone boundaries (WI): I<15, II 15-45, III 45-85, IV 85-180, V 180-240, VI>=240
const ZONE_BOUNDARIES = [15, 45, 85, 180, 240];

// 等値線の閾値は上側（暖温側）気候区分の下限。ラベル・線色と一致させる。
function zoneLabelForThreshold(threshold) {
  if (threshold <= 15) return { key: 'II', roman: 'Ⅱ' };
  if (threshold <= 45) return { key: 'III', roman: 'Ⅲ' };
  if (threshold <= 85) return { key: 'IV', roman: 'Ⅳ' };
  if (threshold <= 180) return { key: 'V', roman: 'Ⅴ' };
  return { key: 'VI', roman: 'Ⅵ' };
}

function polylineLength(latlngs) {
  let sum = 0;
  for (let i = 1; i < latlngs.length; i++) {
    sum += Math.hypot(latlngs[i][0] - latlngs[i - 1][0], latlngs[i][1] - latlngs[i - 1][1]);
  }
  return sum;
}

function rasterEdgeBounds(raster) {
  const { lats, lons, dLat, dLon } = raster;
  const marginLat = (dLat || 0.5) * 0.55;
  const marginLon = (dLon || 0.5) * 0.55;
  return {
    latMin: lats[0],
    latMax: lats[lats.length - 1],
    lonMin: lons[0],
    lonMax: lons[lons.length - 1],
    marginLat,
    marginLon,
  };
}

function isOnDrawingRegionEdge(lat, lon, bounds) {
  return (
    lat <= bounds.latMin + bounds.marginLat ||
    lat >= bounds.latMax - bounds.marginLat ||
    lon <= bounds.lonMin + bounds.marginLon ||
    lon >= bounds.lonMax - bounds.marginLon
  );
}

function interiorPolylineSegments(latlngs, bounds) {
  const segments = [];
  let current = [];
  for (const [lat, lon] of latlngs) {
    if (isOnDrawingRegionEdge(lat, lon, bounds)) {
      if (current.length >= 2) segments.push(current);
      current = [];
    } else {
      current.push([lat, lon]);
    }
  }
  if (current.length >= 2) segments.push(current);
  return segments;
}

const MIN_SEGMENT_LENGTH_FOR_LABEL = 3.0;
const MIN_LABEL_SPACING = 6.0;
const MAX_LABELS_PER_ROMAN = 3;

function labelCountForSegmentLength(length) {
  if (length < MIN_SEGMENT_LENGTH_FOR_LABEL) return 0;
  if (length >= 12) return 2;
  return 1;
}

function dedupeZoneLabels(markers, minDist = MIN_LABEL_SPACING, maxPerRoman = MAX_LABELS_PER_ROMAN) {
  const kept = [];
  const countByRoman = {};
  for (const marker of markers) {
    const romanCount = countByRoman[marker.roman] || 0;
    if (romanCount >= maxPerRoman) continue;
    const tooClose = kept.some((existing) => (
      existing.roman === marker.roman &&
      Math.hypot(
        existing.position[0] - marker.position[0],
        existing.position[1] - marker.position[1],
      ) < minDist
    ));
    if (!tooClose) {
      kept.push(marker);
      countByRoman[marker.roman] = romanCount + 1;
    }
  }
  return kept;
}

function labelPositionsAlongLine(latlngs, count) {
  if (!latlngs?.length) return [];
  if (latlngs.length === 1 || count <= 1) return [latlngs[Math.floor(latlngs.length / 2)]];
  const cum = [0];
  for (let i = 1; i < latlngs.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(latlngs[i][0] - latlngs[i - 1][0], latlngs[i][1] - latlngs[i - 1][1]));
  }
  const total = cum[cum.length - 1];
  if (total === 0) return [latlngs[0]];
  const positions = [];
  for (let k = 1; k <= count; k++) {
    const target = (total * k) / (count + 1);
    let i = 1;
    while (i < cum.length && cum[i] < target) i++;
    const segStart = cum[i - 1];
    const segLen = cum[i] - segStart || 1;
    const t = (target - segStart) / segLen;
    const [lat1, lon1] = latlngs[i - 1];
    const [lat2, lon2] = latlngs[i];
    positions.push([lat1 + (lat2 - lat1) * t, lon1 + (lon2 - lon1) * t]);
  }
  return positions;
}

function createZoneLabelIcon(roman, color) {
  return L.divIcon({
    className: 'zone-contour-label-icon',
    html: `<span class="zone-contour-label-text" style="color:${color}">${roman}</span>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
}
const APP_VERSION = '1.1.3';
const APP_TITLE = '芝しごと・温量指数気候区分マップ';

function darkenHex(hex, amount = 0.55) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = Math.max(0, Math.round(((n >> 16) & 255) * (1 - amount)));
  const g = Math.max(0, Math.round(((n >> 8) & 255) * (1 - amount)));
  const b = Math.max(0, Math.round((n & 255) * (1 - amount)));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function formatWiRange(info) {
  const suffix = info.rangeSuffix || '';
  return `温量指数 ${info.range}${suffix}`;
}

function grassLegendHtml(zone, zoneColor) {
  const primary = (text) => `<span style="color:${darkenHex(zoneColor)};font-weight:700">${text}</span>`;
  const legends = {
    I: `${primary('◎ファインフェスク・ケンタッキーブルーグラス・ベントグラス・トールフェスク')}　〇ライグラス`,
    II: `${primary('◎ファインフェスク・ケンタッキーブルーグラス・ベントグラス・ライグラス類・トールフェスク')}　〇ノシバ`,
    III: `${primary('◎ケンタッキーブルーグラス・ベントグラス・ライグラス類・トールフェスク')}　〇ファインフェスク・コウライシバ　△センチピードグラス・バミューダグラス`,
    IV: `${primary('◎トールフェスク・ノシバ・コウライシバ・センチピードグラス・バミューダグラス')}　〇ケンタッキーブルーグラス・ベントグラス・ライグラス類・バヒアグラス　△ファインフェスク・セントオーガチングラス・シーショアパスパラム・カーペットグラス`,
    V: `${primary('◎ノシバ・コウライシバ・センチピードグラス・バミューダグラス・バヒアグラス')}　〇トールフェスク・セントオーガスチングラス・シーショアパスパラム・カーペットグラス　△ケンタッキーブルーグラス・ベントグラス・ライグラス類・トールフェスク`,
    VI: `${primary('◎ノシバ・コウライシバ・センチピードグラス・バミューダグラス・バヒアグラス・セントオーガスチングラス・シーショアパスパラム・カーペットグラス')}　△ベントグラス・ライグラス類・トールフェスク`,
  };
  return legends[zone] || '';
}

const BANNER_ITEMS = [
  {
    href: 'https://www.turf-tools.jp/services-4',
    src: 'banner_pr_size1.png',
    alt: '芝管理のプロにPRしませんか？農薬・資材・機械メーカー様向け（詳細はターフツールズ）',
  },
  {
    href: 'https://www.turf-tools.jp/blog',
    src: 'bloglink.png',
    alt: '芝管理技術ブログ（ターフツールズ）',
  },
  {
    href: 'https://www.youtube.com/channel/UCSRU0zk4Fj1ETWqMRlJDPJQ',
    src: 'youtubelink.png',
    alt: 'YouTube 現場で役立つ芝管理ノウハウ（グロウアンドプログレス）',
  },
];

const GUIDE_LINKS = [
  {
    label: '🆕 新しい解説',
    href: 'https://www.turf-tools.jp/post/%E3%80%8C%E8%8A%9D%E3%81%97%E3%81%94%E3%81%A8%E3%83%BB%E6%B8%A9%E9%87%8F%E6%8C%87%E6%95%B0%E6%B0%97%E5%80%99%E5%8C%BA%E5%88%86%E3%83%9E%E3%83%83%E3%83%97%E3%80%8Dv1-1-0-%E3%82%92%E5%85%AC%E9%96%8B%E3%81%97%E3%81%BE%E3%81%97%E3%81%9F',
  },
  { label: '▶ 解説動画', href: 'https://youtu.be/sV-Zecw68_c' },
];

const SHIBASHIGOTO_APP_LINKS = [
  { label: 'ポータル', href: 'https://www.turf-tools.jp/portal/' },
  { label: 'ターフプール', href: 'https://www.turf-tools.jp/portal/turfpool/' },
  { label: '楽RAC農薬ローテ', href: 'https://www.turf-tools.jp/portal/rac/' },
  { label: '施肥設計ナビ', href: 'https://fertilization-design.onrender.com/' },
  { label: '病害リスク予報', href: 'https://www.turf-tools.jp/portal/risk/' },
  { label: 'AI相談室', href: 'https://www.turf-tools.jp/aihelpdesk/' },
  { label: 'ピンポイント天気で芝しごと', href: 'https://www.turf-tools.jp/portal/spray/' },
  { label: '病害画像診断AI', href: 'https://www.turf-tools.jp/portal/diagnosis/' },
  { label: '積算温度追跡マップ', href: 'https://turfmap.onrender.com/' },
  { label: 'クレームサバイバル', href: 'https://claim-survival.onrender.com/' },
];

const TurfToolsPrBanner = () => (
  <div className="mx-auto mb-3 flex max-w-[720px] flex-nowrap items-center justify-center gap-2">
    {BANNER_ITEMS.map((item) => (
      <a
        key={item.src}
        href={item.href}
        target="_blank"
        rel="noopener noreferrer"
        className="flex min-w-0 flex-1 items-center justify-center rounded outline-offset-2 hover:opacity-90"
      >
        <img
          src={`${process.env.PUBLIC_URL}/${item.src}`}
          alt={item.alt}
          width={240}
          height={76}
          className="block h-[76px] w-full max-w-[240px] object-contain"
          decoding="async"
        />
      </a>
    ))}
  </div>
);

const FitBoundsToPoints = ({ points }) => {
  const map = useMap();
  useEffect(() => {
    if (!points || points.length === 0) return;
    const bounds = L.latLngBounds(points.map(p => [p.lat, p.lon]));
    map.fitBounds(bounds.pad(0.1));
  }, [map, points]);
  return null;
};

// Chaikin smoothing (corner-cutting) for polylines
function chaikinSmooth(latlngs, iterations = 4) {
  if (!Array.isArray(latlngs) || latlngs.length < 3) return latlngs;
  let pts = latlngs;
  const isClosed = pts.length > 2 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
  for (let it = 0; it < iterations; it++) {
    const next = [];
    const n = pts.length;
    const startIndex = isClosed ? 0 : 1;
    const endIndex = isClosed ? n : n - 1;
    if (!isClosed) next.push(pts[0]);
    for (let i = startIndex; i < endIndex - 1; i++) {
      const p = pts[i];
      const q = pts[i + 1];
      const Q = [0.75 * p[0] + 0.25 * q[0], 0.75 * p[1] + 0.25 * q[1]];
      const R = [0.25 * p[0] + 0.75 * q[0], 0.25 * p[1] + 0.75 * q[1]];
      next.push(Q, R);
    }
    if (!isClosed) next.push(pts[n - 1]);
    if (isClosed && (next.length === 0 || (next[0][0] !== next[next.length - 1][0] || next[0][1] !== next[next.length - 1][1]))) {
      next.push([next[0][0], next[0][1]]);
    }
    pts = next;
    if (pts.length > 12000) break;
  }
  return pts;
}

const YEARS = Array.from({ length: 2025 - 1981 + 1 }, (_, i) => 1981 + i);

function computeWi(lat, lon, year) {
  const base = 120 + (lat - 25) * 10 + (lon - 138) * 0.8 + (year - 2022) * 5;
  return Math.max(0, Math.round(base));
}

function assignZone(wi) {
  if (wi < 15) return 'I';
  if (wi < 45) return 'II';
  if (wi < 85) return 'III';
  if (wi < 180) return 'IV';
  if (wi < 240) return 'V';
  return 'VI';
}

function generateGridData() {
  const latMin = 24.0;
  const latMax = 50.0;
  const lonMin = 123.0;
  const lonMax = 156.0;
  const step = 0.1; // 0.1度精度

  const dataByYear = {};
  YEARS.forEach(year => {
    const points = [];
    for (let lat = latMin; lat <= latMax + 1e-9; lat = Math.round((lat + step) * 10) / 10) {
      for (let lon = lonMin; lon <= lonMax + 1e-9; lon = Math.round((lon + step) * 10) / 10) {
        const wi = computeWi(lat, lon, year);
        const zone = assignZone(wi);
        points.push({ lat: Number(lat.toFixed(1)), lon: Number(lon.toFixed(1)), wi, zone });
      }
    }
    dataByYear[String(year)] = points;
  });

  return {
    metadata: {
      test_mode: false,
      resolution: step,
      years_range: `${YEARS[0]}-${YEARS[YEARS.length - 1]}`,
      total_points: Object.values(dataByYear)[0]?.length || 0,
      region: 'Senkaku_to_Kurils_0.1deg'
    },
    data: dataByYear
  };
}

function buildRasterFromPoints(points) {
  if (!points || points.length === 0) return null;
  const lats = Array.from(new Set(points.map(p => p.lat))).sort((a,b)=>a-b);
  const lons = Array.from(new Set(points.map(p => p.lon))).sort((a,b)=>a-b);
  const latIndex = new Map(lats.map((v,i)=>[v,i]));
  const lonIndex = new Map(lons.map((v,i)=>[v,i]));
  const height = lats.length;
  const width = lons.length;
  const values = new Array(width * height).fill(NaN);
  for (const p of points) {
    const yi = latIndex.get(p.lat);
    const xi = lonIndex.get(p.lon);
    if (yi == null || xi == null) continue;
    values[xi + yi * width] = p.wi;
  }
  // infer cell size
  const dLat = lats.length >= 2 ? +(lats[1] - lats[0]).toFixed(3) : 0.1;
  const dLon = lons.length >= 2 ? +(lons[1] - lons[0]).toFixed(3) : 0.1;
  return { values, width, height, lats, lons, dLat, dLon };
}

function ContourLayer({ points, thresholds, colorForThreshold, showZoneLabels, climateZones }) {
  const { polylines, labels } = useMemo(() => {
    const raster = buildRasterFromPoints(points);
    if (!raster) return { polylines: [], labels: [] };
    const { values, width, height, lats, lons } = raster;
    if (width < 2 || height < 2) return { polylines: [], labels: [] };

    const gen = contours().size([width, height]).thresholds(thresholds);
    const cs = gen(values);

    const yToLat = (y) => {
      const yClamped = Math.max(0, Math.min(height - 1, y));
      const t = height === 1 ? 0 : yClamped / (height - 1);
      return lats[0] + t * (lats[height - 1] - lats[0]);
    };
    const xToLon = (x) => {
      const xClamped = Math.max(0, Math.min(width - 1, x));
      const t = width === 1 ? 0 : xClamped / (width - 1);
      return lons[0] + t * (lons[width - 1] - lons[0]);
    };

    const flattenRings = (coords) => {
      const rings = [];
      const walk = (node) => {
        if (!Array.isArray(node)) return;
        if (node.length > 1 && Array.isArray(node[0]) && typeof node[0][0] === 'number') {
          rings.push(node);
          return;
        }
        for (const child of node) walk(child);
      };
      walk(coords);
      return rings;
    };

    const results = [];
    for (const c of cs) {
      const rings = flattenRings(c.coordinates);
      for (const ring of rings) {
        if (!Array.isArray(ring) || ring.length < 2) continue;
        let latlngs = ring
          .map(([x, y]) => [yToLat(y), xToLon(x)])
          .filter(ll => Array.isArray(ll) && Number.isFinite(ll[0]) && Number.isFinite(ll[1]));
        if (latlngs.length >= 2) {
          latlngs = chaikinSmooth(latlngs, 4);
          results.push({ latlngs, value: c.value });
        }
      }
    }
    const labelMarkers = [];
    if (showZoneLabels) {
      const edgeBounds = rasterEdgeBounds(raster);
      results.forEach((pl, plIdx) => {
        const { key, roman } = zoneLabelForThreshold(pl.value);
        const color = climateZones[key]?.color;
        if (!color) return;
        const segments = interiorPolylineSegments(pl.latlngs, edgeBounds);
        if (segments.length === 0) return;
        const longest = segments.reduce(
          (best, seg) => (polylineLength(seg) > polylineLength(best) ? seg : best),
          segments[0],
        );
        const length = polylineLength(longest);
        const count = labelCountForSegmentLength(length);
        if (count === 0) return;
        const positions = labelPositionsAlongLine(longest, count);
        positions.forEach((pos, posIdx) => {
          if (isOnDrawingRegionEdge(pos[0], pos[1], edgeBounds)) return;
          labelMarkers.push({
            key: `${plIdx}-${posIdx}-${pl.value}`,
            position: pos,
            roman,
            color,
          });
        });
      });
    }
    return { polylines: results, labels: dedupeZoneLabels(labelMarkers) };
  }, [points, thresholds, showZoneLabels, climateZones]);

  return (
    <>
      {polylines.map((pl, idx) => (
        <Polyline
          key={idx}
          positions={pl.latlngs}
          pathOptions={{ color: colorForThreshold(pl.value), weight: 1.6, opacity: 0.95, lineJoin: 'round', lineCap: 'round' }}
        />
      ))}
      {labels.map((lb) => (
        <Marker
          key={lb.key}
          position={lb.position}
          icon={createZoneLabelIcon(lb.roman, lb.color)}
          interactive={false}
        />
      ))}
    </>
  );
}

function ZoneRasterLayer({ points, colorForWi, fillOpacity = 0.25 }) {
  const cells = useMemo(() => {
    const raster = buildRasterFromPoints(points);
    if (!raster) return [];

    const { dLat, dLon } = raster; 


    const halfLat = dLat / 2;
    const halfLon = dLon / 2;
    return points.map(p => {
      const bounds = [
        [p.lat - halfLat, p.lon - halfLon],
        [p.lat + halfLat, p.lon + halfLon],
      ];
      const color = colorForWi(p.wi);
      return { bounds, color };
    });
  }, [points, colorForWi]);

  return (
    <>
      {cells.map((c, i) => (
        <Rectangle key={i} bounds={c.bounds} pathOptions={{ color: c.color, weight: 0, fillColor: c.color, fillOpacity }} />
      ))}
    </>
  );
}

const ClimateMap = () => {
  const [currentYear, setCurrentYear] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [climateData, setClimateData] = useState(null);
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    async function loadData() {
      try {
        const res = await fetch('/climate-grid-0.5deg.json', { cache: 'no-store' });
        if (res.ok) {
          const json = await res.json();
          if (!cancelled) {
            const totalLen = Object.values(json?.data || {}).reduce((s, arr) => s + (Array.isArray(arr) ? arr.length : 0), 0);
            if (totalLen > 0) {
              setClimateData(json);
              // データが読み込まれたら、利用可能な最新年を設定
              const availableYears = Object.keys(json.data).map(Number).sort();
              if (availableYears.length > 0) {
                setCurrentYear(availableYears[availableYears.length - 1]);
              }
              setLoading(false);
              return;
            }
          }
        }
      } catch (_) {}
      if (!cancelled) {
        const dataset = generateGridData();
        setClimateData(dataset);
        // フォールバックデータの場合は最新年を設定
        setCurrentYear(YEARS[YEARS.length - 1]);
        setLoading(false);
      }
    }
    loadData();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (isPlaying) {
      intervalRef.current = setInterval(() => {
        setCurrentYear(prevYear => {
          const years = Object.keys(climateData?.data || {}).map(Number).sort();
          const currentIndex = years.indexOf(prevYear);
          const nextIndex = (currentIndex + 1) % years.length;
          return years[nextIndex];
        });
      }, 1500);
    } else {
      clearInterval(intervalRef.current);
    }
    return () => clearInterval(intervalRef.current);
  }, [isPlaying, climateData]);

  const handlePlayPause = () => setIsPlaying(!isPlaying);
  const handlePrevYear = () => {
    if (!climateData) return;
    const years = Object.keys(climateData.data).map(Number).sort();
    const currentIndex = years.indexOf(currentYear);
    const prevIndex = currentIndex > 0 ? currentIndex - 1 : years.length - 1;
    setCurrentYear(years[prevIndex]);
  };
  const handleNextYear = () => {
    if (!climateData) return;
    const years = Object.keys(climateData.data).map(Number).sort();
    const currentIndex = years.indexOf(currentYear);
    const nextIndex = (currentIndex + 1) % years.length;
    setCurrentYear(years[nextIndex]);
  };

  const climateZones = useMemo(() => ({
    "I": { color: "#2563eb", label: "亜寒帯", range: "< 15" },
    "II": { color: "#059669", label: "冷温帯", range: "15-45" },
    "III": { color: "#65a30d", label: "中間温帯", range: "45-85" },
    "IV": { color: "#d97706", label: "暖温帯", range: "85-180", rangeSuffix: "　WOS向き" },
    "V": { color: "#dc2626", label: "亜熱帯", range: "180-240", rangeSuffix: " WOS向き" },
    "VI": { color: "#7c2d12", label: "熱帯", range: "> 240" }
  }), []);

  const currentData = useMemo(() => (climateData?.data[currentYear.toString()] || []), [climateData, currentYear]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50">
        <div className="text-xl text-gray-600">データ読み込み中...</div>
      </div>
    );
  }

  const zoneStats = (() => {
    const stats = {};
    Object.keys(climateZones).forEach(zone => {
      stats[zone] = currentData.filter(point => point.zone === zone).length;
    });
    return stats;
  })();

  const colorForWi = (wi) => {
    if (wi < 15) return climateZones.I.color;
    if (wi < 45) return climateZones.II.color;
    if (wi < 85) return climateZones.III.color;
    if (wi < 180) return climateZones.IV.color;
    if (wi < 240) return climateZones.V.color;
    return climateZones.VI.color;
  };

  const colorForThreshold = (t) => {
    // threshold lines at zone boundaries: color by the upper zone color
    if (t <= 15) return climateZones.II.color;
    if (t <= 45) return climateZones.III.color;
    if (t <= 85) return climateZones.IV.color;
    if (t <= 180) return climateZones.V.color;
    return climateZones.VI.color;
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <TurfToolsPrBanner />
          <div className="text-center">
            <h1 className="text-2xl font-bold text-gray-900">{APP_TITLE}</h1>
            <p className="text-sm text-gray-600 mt-1">
              v{APP_VERSION} | {climateData?.metadata.region} | {climateData?.metadata.years_range} | 解像度 {climateData?.metadata.resolution}°
            </p>
            <nav className="mt-1.5 flex flex-wrap items-center justify-center gap-x-3 gap-y-2" aria-label="解説">
              {GUIDE_LINKS.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center rounded-full border border-[#c7d2fe] bg-white px-2.5 py-[3px] text-[0.82rem] font-semibold text-[#667eea] no-underline transition-colors hover:border-[#667eea] hover:bg-[#667eea] hover:text-white"
                >
                  {item.label}
                </a>
              ))}
            </nav>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          <div className="lg:col-span-3">
            <div className="bg-white rounded-lg shadow-sm border p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-4xl font-semibold text-gray-900">{currentYear}年</h2>
                <div className="flex items-center space-x-2">
                  <button onClick={handlePrevYear} className="p-2 rounded-lg bg-gray-100 hover:bg-gray-200 transition-colors"><SkipBack size={16} /></button>
                  <button onClick={handlePlayPause} className="p-2 rounded-lg bg-blue-100 hover:bg-blue-200 transition-colors">{isPlaying ? <Pause size={16} /> : <Play size={16} />}</button>
                  <button onClick={handleNextYear} className="p-2 rounded-lg bg-gray-100 hover:bg-gray-200 transition-colors"><SkipForward size={16} /></button>
                </div>
              </div>

              <div className="relative rounded-lg h-[900px] overflow-hidden border">
                <MapContainer center={[35.6762, 139.6503]} zoom={8} className="h-full w-full" preferCanvas={true}>
                  <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  />
                  <FitBoundsToPoints points={currentData} />
                  {/* Zone semi-transparent fills */}
                  <ZoneRasterLayer points={currentData} colorForWi={colorForWi} fillOpacity={0.25} />
                  {/* Contours only at zone boundaries, colored per upper zone */}
                  <ContourLayer
                    points={currentData}
                    thresholds={ZONE_BOUNDARIES}
                    colorForThreshold={colorForThreshold}
                    showZoneLabels={currentYear === 2025}
                    climateZones={climateZones}
                  />
                </MapContainer>
                <div className="absolute top-4 left-4 bg-white/90 rounded-lg px-3 py-2 shadow-sm">
                  <div className="text-2xl font-bold text-gray-900">{currentYear}</div>
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <div className="bg-white rounded-lg shadow-sm border p-4 min-w-[300px]">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">気候区分凡例</h3>
              <div className="space-y-2">
                {Object.entries(climateZones).map(([zone, info]) => (
                  <div key={zone} className="flex items-center space-x-3">
                    <div className="w-4 h-4 rounded-full" style={{ backgroundColor: info.color }} />
                    <div className="flex-1">
                      <div className="text-lg font-medium text-gray-900">{zone}: {info.label}</div>
                      <div className="text-xs text-gray-500">{formatWiRange(info)}</div>
                      <div
                        className="text-[10px] text-gray-600 mt-1"
                        dangerouslySetInnerHTML={{ __html: grassLegendHtml(zone, info.color) }}
                      />
                    </div>
                    <div className="text-sm font-medium text-gray-600">{zoneStats[zone] || 0}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-white rounded-lg shadow-sm border p-4 min-w-[300px]">
              <h3 className="text-sm font-semibold text-gray-900 mb-4">データ統計</h3>
              <div className="space-y-0.5">
                <div className="flex justify-between"><span className="text-xs text-gray-600">対象地点数</span><span className="text-xs font-medium">{currentData.length}</span></div>
                <div className="flex justify-between"><span className="text-xs text-gray-600">平均温量指数</span><span className="text-xs font-medium">{currentData.length > 0 ? Math.round(currentData.reduce((sum, p) => sum + p.wi, 0) / currentData.length) : '-'}</span></div>
                <div className="flex justify-between"><span className="text-xs text-gray-600">最高温量指数</span><span className="text-xs font-medium">{currentData.length > 0 ? Math.max(...currentData.map(p => p.wi)) : '-'}</span></div>
                <div className="flex justify-between"><span className="text-xs text-gray-600">最低温量指数</span><span className="text-xs font-medium">{currentData.length > 0 ? Math.min(...currentData.map(p => p.wi)) : '-'}</span></div>
              </div>
            </div>

            <div className="bg-blue-50 rounded-lg border border-blue-200 p-4 min-w-[300px]">
              <h3 className="text-sm font-semibold text-blue-900 mb-2">説明・操作方法</h3>
              <div className="text-xs text-blue-700 space-y-1">
                <div>• 再生ボタンで自動アニメーション</div>
                <div>• 前/次ボタンで年度切り替え</div>
                <div>• 温量指数とは植物の生育に必要な積算温度を簡便に示す指標であり、月平均温度から5℃を引いた値を足し合わせたもの</div>
              </div>

              <h3 className="text-sm font-semibold text-blue-900 mb-2">　　</h3>
              <div className="text-xs text-blue-700 space-y-1">
                <div>Weather data provided by NASA POWER</div>
                <div>©2025 Growth and Progress</div>
                
              </div>

            </div>
          </div>
        </div>
      </div>

      <footer className="bg-gray-200 border-t-2 border-gray-300 mt-8">
        <div className="max-w-7xl mx-auto px-4 py-8">
          <div className="text-center space-y-5">
            <nav className="flex flex-wrap justify-center gap-x-3 gap-y-2 text-sm" aria-label="芝しごとアプリ">
              {SHIBASHIGOTO_APP_LINKS.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-gray-800 underline hover:text-gray-950"
                >
                  {item.label}
                </a>
              ))}
            </nav>
            <a
              href="https://www.turf-tools.jp/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex flex-col items-center gap-2 text-lg font-medium text-gray-900 hover:opacity-90"
            >
              <img
                src={`${process.env.PUBLIC_URL}/logo.png`}
                alt="G&P 芝しごと"
                className="h-16 w-auto"
                decoding="async"
              />
              <span>グロウアンドプログレス</span>
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default ClimateMap;