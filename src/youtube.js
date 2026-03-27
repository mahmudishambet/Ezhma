const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const db = require('./db');

function getOAuth2Client() {
  const settings = db.get('settings').value();
  return new google.auth.OAuth2(
    settings.youtube_client_id,
    settings.youtube_client_secret,
    settings.youtube_redirect_uri
  );
}

function getAuthUrl() {
  const oauth2Client = getOAuth2Client();
  const scopes = [
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/youtube.force-ssl'
  ];

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent' // force to grab refresh token
  });
}

async function getToken(code) {
  const oauth2Client = getOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
}

async function getChannelInfo(tokens) {
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials(tokens);

  const youtube = google.youtube({
    version: 'v3',
    auth: oauth2Client
  });

  const res = await youtube.channels.list({
    part: 'snippet,statistics',
    mine: true
  });

  if (res.data.items && res.data.items.length > 0) {
    const channel = res.data.items[0];
    return {
      id: channel.id,
      title: channel.snippet.title,
      thumbnails: channel.snippet.thumbnails.default.url,
      subscriberCount: channel.statistics.subscriberCount
    };
  }
  return null;
}

// Function to fetch Live Broadcasts or get default stream key
async function getStreamKey(channelId) {
  const channels = db.get('youtube_channels').value();
  const channelData = channels.find(c => c.id === channelId);
  if (!channelData || !channelData.tokens) throw new Error("Channel not found or no tokens");

  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials(channelData.tokens);

  // We need to refresh if expired, googleapis handles it automatically if refresh_token is present
  const youtube = google.youtube({
    version: 'v3',
    auth: oauth2Client
  });

  // Get active live streams / broadcasts to find the stream key
  // For simplicity, we create a new broadcast and bind it to a new stream
  const date = new Date();
  const titleStr = 'Ezhma Live Stream ' + date.toISOString();

  const broadcastRes = await youtube.liveBroadcasts.insert({
    part: 'snippet,status,contentDetails',
    resource: {
      snippet: { title: titleStr, scheduledStartTime: date.toISOString() },
      status: { privacyStatus: 'public' },
      contentDetails: {
          enableAutoStart: true,
          enableAutoStop: true
      }
    }
  });

  const streamRes = await youtube.liveStreams.insert({
    part: 'snippet,cdn',
    resource: {
      snippet: { title: titleStr },
      cdn: {
        frameRate: '60fps',
        ingestionType: 'rtmp',
        resolution: '1080p'
      }
    }
  });

  await youtube.liveBroadcasts.bind({
    id: broadcastRes.data.id,
    part: 'id,contentDetails',
    streamId: streamRes.data.id
  });

  return streamRes.data.cdn.ingestionInfo.streamName;
}

// Function to upload VOD
async function uploadVideo(taskId) {
  const task = db.get('upload_tasks').find({ id: taskId }).value();
  if (!task || !task.channel_id) throw new Error("Task/Channel not found");

  const channels = db.get('youtube_channels').value();
  const channelData = channels.find(c => c.id === task.channel_id);
  if (!channelData || !channelData.tokens) throw new Error("Channel API tokens not found");

  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials(channelData.tokens);
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

  const videoPath = path.join(__dirname, '../uploads', task.video);
  if (!fs.existsSync(videoPath)) throw new Error("Video file not found");

  console.log(`Starting VOD upload: ${task.title}`);

  db.get('upload_tasks').find({ id: taskId }).assign({ status: 'PROSES UPLOAD' }).write();

  try {
    const res = await youtube.videos.insert({
      part: 'snippet,status',
      requestBody: {
        snippet: {
          title: task.title,
          description: task.description || '',
          tags: task.tags ? task.tags.split(',').map(t => t.trim()) : [],
          categoryId: task.category || '22'
        },
        status: {
          privacyStatus: task.publish_at ? 'private' : (task.privacy ? task.privacy.toLowerCase() : 'private'),
          publishAt: task.publish_at ? new Date(task.publish_at).toISOString() : null
        }
      },
      media: {
        body: fs.createReadStream(videoPath)
      }
    });

    console.log(`Upload completed: ${res.data.id}`);
    db.get('upload_tasks').find({ id: taskId }).assign({ status: 'BERHASIL' }).write();
    return res.data;
  } catch (err) {
    console.error(`Upload failed: ${err.message}`);
    db.get('upload_tasks').find({ id: taskId }).assign({ status: 'GAGAL' }).write();
    throw err;
  }
}

module.exports = {
  getAuthUrl,
  getToken,
  getChannelInfo,
  getStreamKey,
  uploadVideo
};
