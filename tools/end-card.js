// Makes a vertical Short (9:16 mp4) end on the comment/subscribe ask.
//  --trim N   cuts the last N seconds (e.g. a logo outro), so the Short ends, and loops, on the question.
//  --question adds an end card: it dims the last few seconds, asks the A/B question and shows a
//             subscribe line. Leave it out when the video already has its own A/B card (the skits do).
//  --hold N   freezes the last frame for N seconds, so the question lands on a cliffhanger.
//
//   Skit with its own A/B card, drop the 4 s logo outro:
//     node tools/end-card.js in.mp4 out.mp4 --trim 4
//   Video with no ask (trailer, how-to, re-cut):
//     node tools/end-card.js in.mp4 out.mp4 --question "Send or no send?" \
//       --a "A: SEND: help everybody" --b "B: SAY NO: set a budget" \
//       --cta "Subscribe for Part 2" --seconds 3 --hold 1.5
//
// Text stays inside the Shorts safe zone: off the bottom 25% (title, channel name)
// and off the right edge (like/comment buttons). Needs ffmpeg 7.1+ and ffprobe on PATH.
// Keep card text plain: the font has no emoji.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[++i];
    else pos.push(argv[i]);
  }
  return { pos, opt };
}

const { pos: [input, output], opt } = parseArgs(process.argv.slice(2));
if (!input || !output || (!opt.question && !opt.trim)) {
  console.error('Usage: node tools/end-card.js in.mp4 out.mp4 [--trim 4] [--question "..." [--a "..."] [--b "..."] [--cta "..."] [--seconds 3] [--hold 0]]');
  process.exit(1);
}
const seconds = Number(opt.seconds ?? 3);
const hold = Number(opt.hold ?? 0);
const trim = Number(opt.trim ?? 0);
const cta = opt.cta ?? 'Subscribe for Part 2';

const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', input]).toString());
const video = probe.streams.find(s => s.codec_type === 'video');
const hasAudio = probe.streams.some(s => s.codec_type === 'audio');
const W = video.width, H = video.height;
const duration = Number(probe.format.duration) - trim;
if (duration <= 1) throw new Error(`--trim ${trim} leaves nothing of a ${probe.format.duration}s video`);
const start = Math.max(0, duration - seconds); // card appears here; with --hold it runs on into the frozen frame

// Temporary folder holds the font and one text file per line, so no text needs filter escaping.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'endcard-'));
const fontSrc = ['C:/Windows/Fonts/arialbd.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'].find(f => fs.existsSync(f));
if (!fontSrc) throw new Error('No bold font found; edit fontSrc in tools/end-card.js');
fs.copyFileSync(fontSrc, path.join(tmp, 'font.ttf'));

const usableW = W * 0.80;                    // keep clear of the right-hand buttons
const centreX = `(w*0.92-text_w)/2`;         // centre within the left 92% of the frame
function wrap(text, size) {
  const max = Math.max(8, Math.floor(usableW / (size * 0.56)));
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && (line + ' ' + word).length > max) { lines.push(line); line = word; }
    else line = line ? line + ' ' + word : word;
  }
  if (line) lines.push(line);
  return lines;
}

const fade = `alpha='if(lt(t,${start.toFixed(3)}),0,min(1,(t-${start.toFixed(3)})/0.25))'`;
const filters = [];
let n = 0, y = H * 0.20;
function addLines(text, size, style) {
  for (const line of wrap(text, size)) {
    const file = `l${n++}.txt`;
    fs.writeFileSync(path.join(tmp, file), line);
    filters.push(`drawtext=fontfile=font.ttf:textfile=${file}:fontsize=${Math.round(size)}:x=${centreX}:y=${Math.round(y)}:${style}:${fade}`);
    y += size * 1.3;
  }
}

const qSize = W * 0.068, oSize = W * 0.052;
if (opt.question) {
  addLines(opt.question, qSize, 'fontcolor=white:borderw=4:bordercolor=black');
  y += qSize * 0.5;
  if (opt.a) addLines(opt.a, oSize, 'fontcolor=white:box=1:boxcolor=0x1E8E3E@0.92:boxborderw=18');
  if (opt.a) y += oSize * 0.45;
  if (opt.b) addLines(opt.b, oSize, 'fontcolor=white:box=1:boxcolor=0xC62828@0.92:boxborderw=18');
  y += oSize * 0.9;
  addLines('Comment A or B below', oSize, 'fontcolor=white:borderw=3:bordercolor=black');
  y += oSize * 0.6;
  addLines(cta, oSize, 'fontcolor=black:box=1:boxcolor=0xF5C518@0.97:boxborderw=20');
  if (y > H * 0.75) console.warn(`Warning: the card reaches ${Math.round(y / H * 100)}% of the height; shorten the text to keep it above the Shorts title area.`);
}

const cut = trim > 0 ? `trim=end=${duration.toFixed(3)},setpts=PTS-STARTPTS` : null;
const acut = trim > 0 ? `atrim=end=${duration.toFixed(3)},asetpts=PTS-STARTPTS` : null;
const dim = opt.question ? `drawbox=x=0:y=0:w=iw:h=ih:color=black@0.5:t=fill:enable='gte(t,${start.toFixed(3)})'` : null;
const vChain = [cut, hold > 0 ? `tpad=stop_mode=clone:stop_duration=${hold}` : null, dim, ...filters].filter(Boolean).join(',') || 'null';
let graph = `[0:v]${vChain}[v]`;
if (hasAudio) graph += `;[0:a]${[acut, hold > 0 ? `apad=pad_dur=${hold}` : null].filter(Boolean).join(',') || 'anull'}[a]`;
fs.writeFileSync(path.join(tmp, 'graph.txt'), graph);

const outAbs = path.resolve(output);
const args = ['-y', '-v', 'error', '-i', path.resolve(input), '-/filter_complex', 'graph.txt', '-map', '[v]'];
if (hasAudio) args.push('-map', '[a]', '-c:a', 'aac', '-b:a', '192k');
args.push('-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outAbs);
execFileSync('ffmpeg', args, { cwd: tmp, stdio: 'inherit' });
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`Wrote ${output}: ${(duration + hold).toFixed(1)}s` + (opt.question ? `, end card from ${start.toFixed(1)}s` : ''));
