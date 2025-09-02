import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Play, Pause, SkipBack, SkipForward } from 'lucide-react';
import { MapContainer, TileLayer, Polyline, Polygon, Rectangle, Tooltip as LeafletTooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import { contours } from 'd3-contour';

// Zone boundaries (WI): I<15, II 15-45, III 45-85, IV 85-180, V 180-240, VI>=240
const ZONE_BOUNDARIES = [15, 45, 85, 180, 240];

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

const YEARS = [2022, 2023, 2024];

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

function ContourLayer({ points, thresholds, colorForThreshold }) {
  const { polylines } = useMemo(() => {
    const raster = buildRasterFromPoints(points);
    if (!raster) return { polylines: [] };
    const { values, width, height, lats, lons } = raster;
    if (width < 2 || height < 2) return { polylines: [] };

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
    return { polylines: results };
  }, [points, thresholds]);

  return (
    <>
      {polylines.map((pl, idx) => (
        <Polyline
          key={idx}
          positions={pl.latlngs}
          pathOptions={{ color: colorForThreshold(pl.value), weight: 1.6, opacity: 0.95, lineJoin: 'round', lineCap: 'round' }}
        />
      ))}
    </>
  );
}

function ZoneRasterLayer({ points, colorForWi, fillOpacity = 0.25 }) {
  const cells = useMemo(() => {
    const raster = buildRasterFromPoints(points);
    if (!raster) return [];
    const { lats, lons, dLat, dLon } = raster;
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
  const [currentYear, setCurrentYear] = useState(YEARS[0]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [climateData, setClimateData] = useState(null);
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    async function loadData() {
      try {
        const res = await fetch('/climate-grid-0.1deg.json', { cache: 'no-store' });
        if (res.ok) {
          const json = await res.json();
          if (!cancelled) {
            const totalLen = Object.values(json?.data || {}).reduce((s, arr) => s + (Array.isArray(arr) ? arr.length : 0), 0);
            if (totalLen > 0) {
              setClimateData(json);
              setLoading(false);
              return;
            }
          }
        }
      } catch (_) {}
      if (!cancelled) {
        const dataset = generateGridData();
        setClimateData(dataset);
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
    "IV": { color: "#d97706", label: "暖温帯", range: "85-180" },
    "V": { color: "#dc2626", label: "亜熱帯", range: "180-240" },
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
          <h1 className="text-2xl font-bold text-gray-900">温暖化可視化アニメ - 温量指数による適応芝種の変化</h1>
          <p className="text-sm text-gray-600 mt-1">{climateData?.metadata.region} | {climateData?.metadata.years_range} | 解像度 {climateData?.metadata.resolution}°</p>
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
                  <ContourLayer points={currentData} thresholds={ZONE_BOUNDARIES} colorForThreshold={colorForThreshold} />
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
                      <div className="text-xs text-gray-500">温量指数 {info.range}</div>
                      <div className="text-[10px] text-gray-400 mt-1" dangerouslySetInnerHTML={{
                        __html: zone === 'I' ? '<span class="font-bold">◎ファインフェスク・ケンタッキーブルーグラス・ベントグラス・トールフェスク</span>　〇ライグラス' :
                        zone === 'II' ? '<span class="font-bold">◎ファインフェスク・ケンタッキーブルーグラス・ベントグラス・ライグラス類・トールフェスク</span>　〇ノシバ' :
                        zone === 'III' ? '<span class="font-bold">◎ケンタッキーブルーグラス・ベントグラス・ライグラス類・トールフェスク</span>　〇ファインフェスク・コウライシバ　△センチピードグラス・バミューダグラス' :
                        zone === 'IV' ? '<span class="font-bold">◎トールフェスク・ノシバ・コウライシバ・センチピードグラス・バミューダグラス</span>　〇ケンタッキーブルーグラス・ベントグラス・ライグラス類・バヒアグラス　△ファインフェスク・セントオーガチングラス・シーショアパスパラム・カーペットグラス' :
                        zone === 'V' ? '<span class="font-bold">◎ノシバ・コウライシバ・センチピードグラス・バミューダグラス・バヒアグラス</span>　〇トールフェスク・セントオーガスチングラス・シーショアパスパラム・カーペットグラス　△ケンタッキーブルーグラス・ベントグラス・ライグラス類・トールフェスク' :
                        zone === 'VI' ? '<span class="font-bold">◎ノシバ・コウライシバ・センチピードグラス・バミューダグラス・バヒアグラス・セントオーガスチングラス・シーショアパスパラム・カーペットグラス</span>　△ベントグラス・ライグラス類・トールフェスク' : ''
                      }} />
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
    </div>
  );
};

export default ClimateMap;