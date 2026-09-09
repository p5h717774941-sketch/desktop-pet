// Run the current app's exact matte functions against an RGBA frame for comparison.
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync('/Users/a754/Documents/ChatGPT/Pinkmo/src/main.js', 'utf8');
const start = source.indexOf('function opaqueBounds(');
const end = source.indexOf('function extractVideoFrame(', start);
if (start < 0 || end < 0) throw new Error('Matte function boundaries not found');
const width = 512, height = 512;
const data = new Uint8ClampedArray(fs.readFileSync(0));
if (data.length !== width * height * 4) throw new Error('Expected 512x512 RGBA');
const context = { data, width, height };
vm.createContext(context);
vm.runInContext(source.slice(start, end) + '\nremoveAutoSampledBackground({ getImageData: () => ({data}), putImageData: () => {} }, width, height, "protect");', context);
process.stdout.write(Buffer.from(data));
