const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const db = require('./db');
const { getStreamKey } = require('./youtube');

const processes = {};

async function startStream(taskId) {
  const task = db.get('tasks').find({ id: taskId }).value();
  if (!task) return false;

  console.log(`Starting stream for task: ${taskId}`);

  try {
    let streamKey = task.key;
    if (task.youtube_channel_id) {
       console.log(`Fetching stream key from YouTube API for channel ${task.youtube_channel_id}`);
       streamKey = await getStreamKey(task.youtube_channel_id);
       console.log(`Fetched stream key: ${streamKey}`);
    }

    if (!streamKey) {
        throw new Error("No stream key provided");
    }

    const videoPath = path.join(__dirname, '../uploads', task.video);
    const rtmpUrl = `rtmp://a.rtmp.youtube.com/live2/${streamKey}`;

    const command = ffmpeg(videoPath)
      .inputOptions([
        '-re', // Read input at native frame rate
        '-stream_loop', '-1' // Loop infinitely
      ])
      .outputOptions([
        '-c:v', 'copy',      // copy video stream
        '-c:a', 'aac',       // AAC audio
        '-b:a', '128k',      // Audio bitrate
        '-f', 'flv',         // Format FLV for RTMP
        '-flvflags', 'no_duration_filesize'
      ])
      .output(rtmpUrl)
      .on('start', (commandLine) => {
        console.log(`Spawned FFmpeg for task ${taskId}: ${commandLine}`);
        db.get('tasks').find({ id: taskId }).assign({
            status: 'AKTIF',
            pid: command.ffmpegProc ? command.ffmpegProc.pid : null // In newer fluent-ffmpeg, process can be accessed or we just store running status
        }).write();
        processes[taskId] = command;
      })
      .on('error', (err, stdout, stderr) => {
        console.log(`Error on stream ${taskId}:`, err.message);
        stopStream(taskId);
      })
      .on('end', () => {
        console.log(`Stream ${taskId} ended naturally`);
        stopStream(taskId);
      });

    command.run();

    // Store in our local process tracker
    processes[taskId] = command;

    return true;
  } catch (err) {
    console.error(`Failed to start stream ${taskId}:`, err.message);
    db.get('tasks').find({ id: taskId }).assign({ status: 'ERROR' }).write();
    return false;
  }
}

function stopStream(taskId) {
  const task = db.get('tasks').find({ id: taskId }).value();
  if (!task) return;

  if (processes[taskId]) {
    console.log(`Killing FFmpeg process for task: ${taskId}`);
    processes[taskId].kill('SIGKILL');
    delete processes[taskId];
  }

  db.get('tasks').find({ id: taskId }).assign({
      status: 'DIHENTIKAN',
      pid: null
  }).write();

  console.log(`Stream ${taskId} stopped`);
}

module.exports = {
  startStream,
  stopStream,
  processes
};
