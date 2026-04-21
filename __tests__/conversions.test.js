import { spawnSync } from 'child_process';
import { existsSync, statSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CONVERSION_MAP, getFFmpegArgs, getSpeedArgs } from '../lib/formats.js';

const ffmpegAvailable = (() => {
  const r = spawnSync('ffmpeg', ['-version'], { stdio: 'pipe' });
  return r.error == null && r.status === 0;
})();

const describe_ = ffmpegAvailable ? describe : describe.skip;

function ff(...args) {
  return spawnSync('ffmpeg', ['-y', ...args], { stdio: 'pipe' });
}

function probe(path, entry) {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', `format=${entry}`,
    '-of', 'default=noprint_wrappers=1:nokey=1', path,
  ], { encoding: 'utf8', stdio: 'pipe' });
  return (r.stdout ?? '').trim();
}

const TMP = tmpdir();
const FIXTURES = {};

// Pure logic — always runs
describe('CONVERSION_MAP completeness', () => {
  test('all required source formats are present', () => {
    for (const fmt of ['mov', 'avi', 'mkv', 'webm', 'gif', 'mp4']) {
      expect(CONVERSION_MAP).toHaveProperty(fmt);
      expect(CONVERSION_MAP[fmt].length).toBeGreaterThan(0);
    }
  });

  test('getFFmpegArgs returns array with -i and output filename', () => {
    const args = getFFmpegArgs('mov', 'mp4', 'in.mov', 'out.mp4');
    expect(args).toContain('-i');
    expect(args).toContain('in.mov');
    expect(args[args.length - 1]).toBe('out.mp4');
  });

  test('getSpeedArgs 2× includes setpts filter', () => {
    const args = getSpeedArgs('in.mp4', 'out.mp4', 2, 1);
    expect(args.join(' ')).toMatch(/setpts=0\.5/);
    expect(args.join(' ')).toMatch(/atempo=2/);
  });

  test('getSpeedArgs loop 3× includes stream_loop 2', () => {
    const args = getSpeedArgs('in.mp4', 'out.mp4', 1, 3);
    const idx = args.indexOf('-stream_loop');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('2');
  });

  test('getSpeedArgs speed=1 loop=1 uses -c copy', () => {
    const args = getSpeedArgs('in.mp4', 'out.mp4', 1, 1);
    expect(args).toContain('-c');
    expect(args).toContain('copy');
  });
});

// FFmpeg integration — skipped when ffmpeg is not on PATH
describe_('fixture-based integration', () => {
  beforeAll(() => {
    const mp4 = join(TMP, 'fix.mp4');
    ff('-f', 'lavfi', '-i', 'color=c=blue:size=160x120:duration=2:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=22050',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
      '-c:a', 'aac', '-shortest', mp4);
    FIXTURES.mp4 = mp4;

    for (const ext of ['mov', 'mkv']) {
      const p = join(TMP, `fix.${ext}`);
      ff('-i', mp4, '-c', 'copy', p);
      FIXTURES[ext] = existsSync(p) ? p : null;
    }

    const avi = join(TMP, 'fix.avi');
    const aviR = ff('-i', mp4, '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'libmp3lame', avi);
    FIXTURES.avi = aviR.status === 0 ? avi : null;

    const webm = join(TMP, 'fix.webm');
    const webmR = ff(
      '-f', 'lavfi', '-i', 'color=c=blue:size=160x120:duration=2:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=22050',
      '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '30',
      '-c:a', 'libopus', '-shortest', webm);
    FIXTURES.webm = webmR.status === 0 ? webm : null;

    const gif = join(TMP, 'fix.gif');
    ff('-f', 'lavfi', '-i', 'color=c=red:size=160x120:duration=2:rate=5', '-loop', '0', gif);
    FIXTURES.gif = existsSync(gif) ? gif : null;
  });

  afterAll(() => {
    Object.values(FIXTURES).forEach(p => {
      if (p && existsSync(p)) unlinkSync(p);
    });
  });

  describe('format conversions', () => {
    const cases = Object.entries(CONVERSION_MAP).flatMap(([inp, outs]) =>
      outs.map(out => [inp, out]));

    test.each(cases)('%s → %s', (inputFmt, outputFmt) => {
      const inputPath = FIXTURES[inputFmt];
      if (!inputPath || !existsSync(inputPath)) {
        console.warn(`Skipping ${inputFmt}→${outputFmt}: fixture unavailable`);
        return;
      }

      const outputPath = join(TMP, `out_${inputFmt}_${outputFmt}.${outputFmt}`);
      try {
        const result = ff(...getFFmpegArgs(inputFmt, outputFmt, inputPath, outputPath));
        expect(result.status).toBe(0);
        expect(existsSync(outputPath)).toBe(true);
        expect(statSync(outputPath).size).toBeGreaterThan(100);

        const fmt = probe(outputPath, 'format_name');
        if (outputFmt === 'mp4') {
          expect(fmt).toMatch(/mp4/);
        } else if (outputFmt === 'gif') {
          expect(fmt).toBe('gif');
          const magic = readFileSync(outputPath).toString('ascii', 0, 6);
          expect(['GIF87a', 'GIF89a']).toContain(magic);
        }
      } finally {
        if (existsSync(outputPath)) unlinkSync(outputPath);
      }
    });
  });

  describe('speed and loop', () => {
    test('2× speed produces ~half duration', () => {
      const inputPath = FIXTURES.mp4;
      expect(inputPath && existsSync(inputPath)).toBeTruthy();
      const outputPath = join(TMP, 'speed2x.mp4');
      const inputDur = parseFloat(probe(inputPath, 'duration'));

      const result = ff(...getSpeedArgs(inputPath, outputPath, 2, 1));
      expect(result.status).toBe(0);

      const outDur = parseFloat(probe(outputPath, 'duration'));
      expect(outDur).toBeGreaterThan(0);
      expect(outDur).toBeLessThan(inputDur * 0.75);

      if (existsSync(outputPath)) unlinkSync(outputPath);
    });

    test('loop 2× produces ~double duration', () => {
      const inputPath = FIXTURES.mp4;
      expect(inputPath && existsSync(inputPath)).toBeTruthy();
      const outputPath = join(TMP, 'loop2x.mp4');
      const inputDur = parseFloat(probe(inputPath, 'duration'));

      const result = ff(...getSpeedArgs(inputPath, outputPath, 1, 2));
      expect(result.status).toBe(0);

      const outDur = parseFloat(probe(outputPath, 'duration'));
      expect(outDur).toBeGreaterThan(inputDur * 1.5);

      if (existsSync(outputPath)) unlinkSync(outputPath);
    });

    test('speed=1 loop=1 copies without re-encoding', () => {
      const inputPath = FIXTURES.mp4;
      expect(inputPath && existsSync(inputPath)).toBeTruthy();
      const outputPath = join(TMP, 'copy.mp4');

      const result = ff(...getSpeedArgs(inputPath, outputPath, 1, 1));
      expect(result.status).toBe(0);
      expect(existsSync(outputPath)).toBe(true);

      if (existsSync(outputPath)) unlinkSync(outputPath);
    });
  });
});
