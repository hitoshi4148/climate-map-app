import requests
import json
import time
from datetime import datetime
import os

class JapanClimateTestFetcher:
    def __init__(self):
        self.base_url = "https://power.larc.nasa.gov/api/temporal/monthly/point"
        self.parameters = "T2M"  # 2m気温
        self.community = "SB"   # Sustainable Buildings (RE→SBに変更)
        self.format = "JSON"
        
        # テスト用：関東地方のみ（約3×3=9地点）
        self.lat_min, self.lat_max = 35.0, 37.0
        self.lon_min, self.lon_max = 139.0, 141.0
        self.resolution = 1.0  # テスト用に1度間隔（粗い）
        
        # テスト用：最近3年分のみ
        self.start_year = 2022
        self.end_year = 2024
    
    def generate_test_points(self):
        """テスト用グリッドポイントを生成"""
        points = []
        lat = self.lat_min
        while lat <= self.lat_max:
            lon = self.lon_min
            while lon <= self.lon_max:
                points.append((round(lat, 1), round(lon, 1)))
                lon += self.resolution
            lat += self.resolution
        
        print(f"テスト用グリッドポイント数: {len(points)}")
        print("対象地点:")
        for i, (lat, lon) in enumerate(points):
            print(f"  {i+1}: 北緯{lat}度, 東経{lon}度")
        return points
    
    def fetch_temperature_data(self, lat, lon):
        """指定地点の気温データを取得"""
        # URLパラメータを修正
        url = f"{self.base_url}?parameters={self.parameters}&community={self.community}&longitude={lon}&latitude={lat}&start={self.start_year}&end={self.end_year}&format={self.format}"
        
        print(f"  API呼び出し: 北緯{lat}度, 東経{lon}度")
        print(f"  URL: {url}")  # デバッグ用
        
        try:
            response = requests.get(url, timeout=30)
            print(f"  レスポンスコード: {response.status_code}")  # デバッグ用
            
            if response.status_code != 200:
                print(f"  レスポンス内容: {response.text[:200]}...")  # エラー詳細
            
            response.raise_for_status()
            data = response.json()
            
            if 'properties' in data and 'parameter' in data['properties']:
                temp_data = data['properties']['parameter']['T2M']
                print(f"  ✓ データ取得成功: {len(temp_data)}ヶ月分")
                return temp_data
            else:
                print(f"  ✗ データなし")
                print(f"  レスポンス構造: {list(data.keys()) if data else 'None'}")
                return None
                
        except requests.exceptions.RequestException as e:
            print(f"  ✗ API エラー: {e}")
            return None
        except json.JSONDecodeError as e:
            print(f"  ✗ JSON エラー: {e}")
            return None
    
    def calculate_warmth_index(self, monthly_temps):
        """月平均気温から温量指数を計算"""
        if not monthly_temps:
            return None
        
        warmth_index = 0
        valid_months = 0
        
        for temp in monthly_temps.values():
            if temp is not None:
                valid_months += 1
                if temp > 5:
                    warmth_index += (temp - 5)
        
        print(f"    有効月数: {valid_months}, 温量指数: {round(warmth_index, 1)}")
        return round(warmth_index, 1)
    
    def determine_climate_zone(self, warmth_index):
        """温量指数から気候区分を判定"""
        if warmth_index is None:
            return None
        elif warmth_index < 15:
            return "I"    # 亜寒帯
        elif warmth_index < 45:
            return "II"   # 冷温帯
        elif warmth_index < 85:
            return "III"  # 中間温帯
        elif warmth_index < 180:
            return "IV"   # 暖温帯
        elif warmth_index < 240:
            return "V"    # 亜熱帯
        else:
            return "VI"   # 熱帯
    
    def process_yearly_data(self, temp_data):
        """年度別に温量指数と気候区分を計算"""
        yearly_results = {}
        
        # 月別データを年度別にグループ化
        for date_str, temp in temp_data.items():
            year = int(date_str[:4])
            month = int(date_str[4:6])
            
            if year not in yearly_results:
                yearly_results[year] = {}
            
            yearly_results[year][month] = temp
        
        # 各年の温量指数を計算
        final_results = {}
        for year, monthly_temps in yearly_results.items():
            print(f"    {year}年: {len(monthly_temps)}ヶ月分のデータ")
            if len(monthly_temps) >= 12:  # 12ヶ月分のデータが揃っている場合
                wi = self.calculate_warmth_index(monthly_temps)
                zone = self.determine_climate_zone(wi)
                final_results[year] = {
                    'warmth_index': wi,
                    'climate_zone': zone
                }
                print(f"    {year}年: 温量指数={wi}, 気候区分={zone}")
            else:
                print(f"    {year}年: データ不完全（{len(monthly_temps)}ヶ月分）")
        
        return final_results
    
    def run_test(self):
        """テスト実行"""
        print("=" * 50)
        print("NASA POWER API テスト開始")
        print("=" * 50)
        
        grid_points = self.generate_test_points()
        
        test_results = {
            'metadata': {
                'test_mode': True,
                'resolution': self.resolution,
                'years_range': f"{self.start_year}-{self.end_year}",
                'total_points': len(grid_points),
                'generated_at': datetime.now().isoformat(),
                'region': 'Kanto_test'
            },
            'data': {}
        }
        
        # 年度別データ構造を初期化
        for year in range(self.start_year, self.end_year + 1):
            test_results['data'][str(year)] = []
        
        success_count = 0
        
        for i, (lat, lon) in enumerate(grid_points):
            print(f"\n[{i+1}/{len(grid_points)}] 処理中...")
            
            # 気温データを取得
            temp_data = self.fetch_temperature_data(lat, lon)
            
            if temp_data:
                # 年度別に処理
                yearly_data = self.process_yearly_data(temp_data)
                
                # 結果を格納
                for year_str, year_result in yearly_data.items():
                    year_key = str(year_str)
                    if year_key in test_results['data']:
                        test_results['data'][year_key].append({
                            'lat': lat,
                            'lon': lon,
                            'wi': year_result['warmth_index'],
                            'zone': year_result['climate_zone']
                        })
                
                success_count += 1
            
            # API制限対策（少し待機）
            time.sleep(1)
        
        print(f"\n=" * 50)
        print(f"テスト完了: {success_count}/{len(grid_points)} 地点成功")
        print("=" * 50)
        
        return test_results
    
    def save_test_data(self, data, filename='test_climate_data.json'):
        """テストデータをJSONファイルに保存"""
        with open(filename, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        
        file_size = os.path.getsize(filename)
        print(f"\nテストデータを保存しました: {filename}")
        print(f"ファイルサイズ: {file_size} bytes ({round(file_size/1024, 2)} KB)")
        
        # データ内容の概要を表示
        print(f"\nデータ概要:")
        print(f"  対象年度: {list(data['data'].keys())}")
        for year, points in data['data'].items():
            print(f"  {year}年: {len(points)} 地点")
            if points:
                zones = [p['zone'] for p in points if p['zone']]
                zone_counts = {zone: zones.count(zone) for zone in set(zones)}
                print(f"    気候区分: {zone_counts}")

# メイン実行部分
if __name__ == "__main__":
    print("NASA POWER API テストスクリプト")
    print("対象地域: 関東地方")
    print("対象年度: 2022-2024年")
    print("\n実行しますか？ (y/n): ", end="")
    
    # Cursorでは入力待ちをスキップして直接実行
    user_input = "y"  # 自動実行用
    
    if user_input.lower() == 'y':
        fetcher = JapanClimateTestFetcher()
        test_data = fetcher.run_test()
        fetcher.save_test_data(test_data)
        
        print("\n✓ テスト完了！")
        print("生成されたファイル: test_climate_data.json")
        print("このファイルを確認してから全国版を実行してください。")
    else:
        print("テストをキャンセルしました。")
