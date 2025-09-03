import React from 'react';
import './App.css';
import ClimateMap from './ClimateMap';

function App() {
  return (
    <div className="App">
      <div className="bg-blue-500 text-white p-8 text-2xl text-center">
        App.js が実行されています - ClimateMapコンポーネントを読み込み中...
      </div>
      <ClimateMap />
    </div>
  );
}

export default App;
