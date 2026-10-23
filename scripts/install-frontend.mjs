import fs from 'node:fs';
import path from 'node:path';
const assets=['studio.css'];
const version=JSON.parse(fs.readFileSync('package.json','utf8')).version;
if(!/^\d+\.[0-9]\.[0-9]$/.test(version))throw new Error('System version must use MAJOR.MINOR.PATCH with single-digit MINOR and PATCH (0–9).');
if(!fs.existsSync('public/modern/assets/studio.css'))throw new Error('Missing compiled stylesheet');
if(assets.length!==1)throw new Error(`Expected one frontend stylesheet, found ${assets.length}`);
let html=fs.readFileSync('public/index.html','utf8').replace(/\n\s*<!-- MODERN START -->[\s\S]*?<!-- MODERN END -->/g,'');
html=html.replace('</head>',`<!-- MODERN START -->\n    <link id="studio-modern-styles" rel="stylesheet" href="/modern/assets/${assets[0]}?v=${version}" />\n    <!-- MODERN END -->\n  </head>`);
html=html.replace('</body>',`<!-- MODERN START -->\n    <script src="/bridge.js"></script>\n    <script id="studio-modern-script" type="module" src="/modern/studio.js?v=${version}-theme-sync"></script>\n    <!-- MODERN END -->\n  </body>`);
const startup=fs.readFileSync('public/startup.js','utf8');
// Inline the small boot controller so it cannot wait on, or fail as, an extra request.
html=html.replace(/<script(?: id="studio-startup-script")? src="\/startup\.js\?v=[^"]+"><\/script>|<script id="studio-startup-script">[\s\S]*?<\/script>/,()=>`<script id="studio-startup-script">\n${startup}    </script>`);
fs.writeFileSync('public/index.html',html);
