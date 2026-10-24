import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Only server-probed metadata may be used for billing. Never fall back to client input. */
export async function probeVideoDuration(filePath) {
  let stdout;
  try {
    ({ stdout } = await run(process.env.FFPROBE_PATH || 'ffprobe', [
      '-v', 'error', '-protocol_whitelist', 'file,pipe',
      '-show_entries', 'format=duration:stream=codec_type,duration',
      '-of', 'json', filePath,
    ], { timeout: 30000, maxBuffer: 1024 * 1024 }));
  } catch (err) {
    throw Object.assign(new Error(err.code === 'ENOENT'
      ? '服务器缺少 ffprobe，无法核实视频时长，请联系管理员安装'
      : '无法读取视频时长，请检查视频文件'), { status: err.code === 'ENOENT' ? 503 : 422 });
  }
  let metadata;
  try { metadata = JSON.parse(stdout); } catch { metadata = {}; }
  const videos = (metadata.streams || []).filter((s) => s.codec_type === 'video');
  const durations = [metadata.format?.duration, ...videos.map((s) => s.duration)]
    .map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (!videos.length || !durations.length) {
    throw Object.assign(new Error('文件没有可确认时长的视频流'), { status: 422 });
  }
  return Math.max(...durations);
}
