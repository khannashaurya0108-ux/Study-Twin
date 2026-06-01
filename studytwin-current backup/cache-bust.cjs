const fs = require('fs');
const files = ['index.html', 'dashboard.html', 'brain-map.html', 'blink.html', 'how-it-works.html', 'get-started.html'];
const cacheBuster = Date.now();

files.forEach(f => {
  if (fs.existsSync(f)) {
    let d = fs.readFileSync(f, 'utf8');
    d = d.replace(/src="app\.js[^">]*"/g, 'src="app.js?v=' + cacheBuster + '"');
    d = d.replace(/src="auth\.js[^">]*"/g, 'src="auth.js?v=' + cacheBuster + '"');
    fs.writeFileSync(f, d);
    console.log(`Updated ${f}`);
  }
});
