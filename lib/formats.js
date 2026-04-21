export const CONVERSION_MAP = {
  mp4:  ['mov', 'avi', 'mkv', 'webm', 'gif'],
  mov:  ['mp4', 'avi', 'mkv', 'webm', 'gif'],
  avi:  ['mp4', 'mov', 'mkv', 'webm', 'gif'],
  mkv:  ['mp4', 'mov', 'avi', 'webm', 'gif'],
  webm: ['mp4', 'mov', 'avi', 'mkv',  'gif'],
  gif:  ['mp4', 'mov', 'avi', 'mkv',  'webm'],
};

export const MIME_TO_EXT = {
  'video/quicktime': 'mov',
  'video/x-msvideo': 'avi',
  'video/x-matroska': 'mkv',
  'video/webm': 'webm',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
};

export function getExtFromFile(file) {
  const ext = file.name.toLowerCase().split('.').pop();
  if (CONVERSION_MAP[ext]) return ext;
  return MIME_TO_EXT[file.type] ?? null;
}

export function getFFmpegArgs(inputFmt, outputFmt, inputName, outputName) {
  const input = ['-i', inputName];
  const hasAudio = inputFmt !== 'gif';

  if (outputFmt === 'mp4' || outputFmt === 'mov' || outputFmt === 'mkv') {
    const args = [...input, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p'];
    if (hasAudio) args.push('-c:a', 'aac');
    args.push('-movflags', '+faststart', outputName);
    return args;
  }

  if (outputFmt === 'avi') {
    const args = [...input, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p'];
    if (hasAudio) args.push('-c:a', 'libmp3lame');
    args.push(outputName);
    return args;
  }

  if (outputFmt === 'webm') {
    const args = [...input, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '30', '-pix_fmt', 'yuv420p'];
    if (hasAudio) args.push('-c:a', 'libopus');
    args.push(outputName);
    return args;
  }

  if (outputFmt === 'gif') {
    return [
      ...input,
      '-filter_complex',
      '[0:v]fps=10,scale=480:-2:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse[out]',
      '-map', '[out]',
      '-an',
      '-loop', '0',
      outputName,
    ];
  }

  throw new Error(`Unsupported conversion: ${inputFmt} → ${outputFmt}`);
}

function buildAtempoChain(speed) {
  if (speed < 0.5) {
    const steps = [];
    let s = speed;
    while (s < 0.5) { steps.push('atempo=0.5'); s *= 2; }
    steps.push(`atempo=${s.toFixed(4)}`);
    return steps.join(',');
  }
  if (speed > 2) {
    const steps = [];
    let s = speed;
    while (s > 2) { steps.push('atempo=2.0'); s /= 2; }
    steps.push(`atempo=${s.toFixed(4)}`);
    return steps.join(',');
  }
  return `atempo=${speed}`;
}

export function getSpeedArgs(inputName, outputName, speed, loops) {
  const args = [];
  if (loops > 1) args.push('-stream_loop', String(loops - 1));
  args.push('-i', inputName);

  if (speed === 1) {
    args.push('-c', 'copy');
  } else {
    args.push(
      '-filter:v', `setpts=${(1 / speed).toFixed(6)}*PTS`,
      '-filter:a', buildAtempoChain(speed),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
      '-c:a', 'aac',
    );
  }

  args.push('-movflags', '+faststart', outputName);
  return args;
}
