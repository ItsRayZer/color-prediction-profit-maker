const https = require('https');
const fs = require('fs');

https.get('https://unpkg.com/lightweight-charts@5.0.9/dist/lightweight-charts.standalone.production.js', (res) => {
  let code = '';
  res.on('data', c => code += c);
  res.on('end', () => {
    // Run test
    try {
      const { JSDOM } = require('jsdom');
      const dom = new JSDOM('<!DOCTYPE html><html><body><div id="c" style="width:400px;height:400px"></div></body></html>', {
        runScripts: 'dangerously',
        pretendToBeVisual: true
      });
      dom.window.eval(code);
      const LC = dom.window.LightweightCharts;
      console.log('LC available:', !!LC);
      const container = dom.window.document.getElementById('c');
      Object.defineProperty(container, 'clientWidth', { value: 400 });
      Object.defineProperty(container, 'clientHeight', { value: 400 });
      
      const chart = LC.createChart(container, {
        width: 400,
        height: 400
      });
      const series = chart.addSeries(LC.CandlestickSeries);
      
      console.log('Series created successfully');
      
      const candles = [
        { time: 1710000000, open: 10, high: 15, low: 8, close: 12 },
        { time: 1710000030, open: 12, high: 18, low: 11, close: 17 }
      ];
      series.setData(candles);
      console.log('Candles setData succeeded');
    } catch (e) {
      console.error('Test error:', e);
    }
  });
});
