const cron = require('node-cron');
const moment = require('moment-timezone');
const db = require('./db');
const { startStream, stopStream, processes } = require('./streamManager');
const { uploadVideo } = require('./youtube');

function initCron() {
  console.log('Initializing cron jobs scheduler...');
  
  // Run every minute
  cron.schedule('* * * * *', async () => {
    const settings = db.get('settings').value();
    const tz = settings.timezone || 'Asia/Jakarta';
    const now = moment().tz(tz);
    
    // Very simplified scheduler logic for Live Streams
    const tasks = db.get('tasks').value();
    
    for (const task of tasks) {
      if (task.status === 'AKTIF') {
        // Handle auto-stop logic if needed
      } else if (task.status === 'DIJADWALKAN') {
        const startMoment = task.start ? moment.tz(task.start, tz) : null;
        if (startMoment && now.isSameOrAfter(startMoment)) {
            await startStream(task.id);
        }
      }
    }

    // Scheduler logic for VOD Uploads
    const uploadTasks = db.get('upload_tasks').value() || [];
    for (const uTask of uploadTasks) {
       if (uTask.status === 'MENUNGGU') {
          let shouldUpload = false;
          if (!uTask.publish_at) {
             shouldUpload = true; // Instant upload
          } else {
             const pubMoment = moment.tz(uTask.publish_at, tz);
             if (now.isSameOrAfter(pubMoment)) {
                shouldUpload = true;
             }
          }

          if (shouldUpload) {
             // Execute without awaiting to allow loop to continue
             uploadVideo(uTask.id).catch(e => console.error("Upload VOD Error:", e));
          }
       }
    }
  });
}

module.exports = { initCron };
