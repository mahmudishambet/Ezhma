const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const db = require('./src/db');
const { getAuthUrl, getToken, getChannelInfo } = require('./src/youtube');
const { startStream, stopStream } = require('./src/streamManager');
const { initCron } = require('./src/cronJobs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

app.use(session({
  secret: 'ezhma-secret-123',
  resave: false,
  saveUninitialized: true
}));

const upload = multer({ dest: 'uploads/' });

// Auth Middleware
function requireAuth(req, res, next) {
  if (req.session.isLoggedIn) return next();
  res.redirect('/login');
}

// Routes
app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', (req, res) => {
  const { password } = req.body;
  const settings = db.get('settings').value();
  if (password === settings.password) {
    req.session.isLoggedIn = true;
    res.redirect('/dashboard');
  } else {
    res.render('login', { error: 'Sandi salah!' });
  }
});
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Main Dashboard
app.get('/', (req, res) => res.redirect('/dashboard'));
app.get('/dashboard', requireAuth, (req, res) => {
  const tasks = db.get('tasks').value();
  const settings = db.get('settings').value();
  res.render('dashboard', { tasks, settings });
});

// Buat Tugas Live
app.get('/buat-tugas', requireAuth, (req, res) => {
  const videos = fs.existsSync(path.join(__dirname, 'uploads')) 
    ? fs.readdirSync(path.join(__dirname, 'uploads')).filter(f => f.endsWith('.mp4') || f.endsWith('.mkv'))
    : [];
  const channels = db.get('youtube_channels').value();
  res.render('buat-tugas', { videos, channels });
});
app.post('/buat-tugas', requireAuth, (req, res) => {
  const { title, video, stream_key, channel_id, start_time, end_time, repeat, loop_video } = req.body;
  const task = {
    id: Date.now().toString(),
    title,
    video,
    key: stream_key,
    youtube_channel_id: channel_id || null,
    status: start_time ? 'DIJADWALKAN' : 'AKTIF',
    start: start_time || new Date().toISOString(),
    end: end_time || null,
    repeat: repeat || 'Tidak Ada',
    loop: loop_video === 'on'
  };
  db.get('tasks').push(task).write();
  
  if (task.status === 'AKTIF') {
    startStream(task.id);
  }
  
  res.redirect('/dashboard');
});

// Stop Tugas
app.post('/stop-tugas/:id', requireAuth, (req, res) => {
  stopStream(req.params.id);
  res.redirect('/dashboard');
});

// Pengaturan & API Integration
app.get('/pengaturan', requireAuth, (req, res) => {
  const settings = db.get('settings').value();
  const channels = db.get('youtube_channels').value();
  const authUrl = settings.youtube_client_id ? getAuthUrl() : null;
  res.render('pengaturan', { settings, channels, authUrl });
});

app.post('/pengaturan/sandi', requireAuth, (req, res) => {
  db.get('settings').assign({ password: req.body.new_password }).write();
  res.redirect('/pengaturan');
});

app.post('/pengaturan/api', requireAuth, (req, res) => {
  db.get('settings').assign({
    youtube_client_id: req.body.client_id,
    youtube_client_secret: req.body.client_secret,
    youtube_redirect_uri: req.body.redirect_uri
  }).write();
  res.redirect('/pengaturan');
});

// YouTube OAuth Callback
app.get('/auth/youtube/callback', requireAuth, async (req, res) => {
  const code = req.query.code;
  if (code) {
    try {
      const tokens = await getToken(code);
      const channelInfo = await getChannelInfo(tokens);
      if (channelInfo) {
        db.get('youtube_channels').push({
          id: channelInfo.id,
          title: channelInfo.title,
          thumbnails: channelInfo.thumbnails,
          tokens: tokens
        }).write();
      }
    } catch (err) {
      console.error('OAuth Callback Error:', err);
    }
  }
  res.redirect('/pengaturan');
});

// Upload Terjadwal (VOD)
app.get('/upload-terjadwal', requireAuth, (req, res) => {
  const videos = fs.existsSync(path.join(__dirname, 'uploads')) 
    ? fs.readdirSync(path.join(__dirname, 'uploads')).filter(f => f.endsWith('.mp4') || f.endsWith('.mkv'))
    : [];
  const channels = db.get('youtube_channels').value();
  const uploadTasks = db.get('upload_tasks').value();
  res.render('upload-terjadwal', { videos, channels, uploadTasks });
});

app.post('/upload-terjadwal', requireAuth, (req, res) => {
  const { title, description, tags, video, channel_id, publish_at, monetization, privacy, category } = req.body;
  const task = {
    id: Date.now().toString(),
    title,
    description,
    tags,
    video,
    channel_id,
    publish_at: publish_at || null,
    monetization: monetization === 'on',
    privacy: privacy || 'private',
    category: category || '22',
    status: 'MENUNGGU'
  };
  db.get('upload_tasks').push(task).write();
  res.redirect('/upload-terjadwal');
});

app.post('/hapus-upload/:id', requireAuth, (req, res) => {
  db.get('upload_tasks').remove({ id: req.params.id }).write();
  res.redirect('/upload-terjadwal');
});

// Berkas Video
app.get('/berkas-video', requireAuth, (req, res) => {
  const videos = fs.existsSync(path.join(__dirname, 'uploads')) 
    ? fs.readdirSync(path.join(__dirname, 'uploads')).filter(f => f.endsWith('.mp4') || f.endsWith('.mkv'))
    : [];
  res.render('berkas-video', { videos });
});

app.post('/upload-local', requireAuth, upload.single('video_file'), (req, res) => {
  if (req.file) {
    const originalName = req.file.originalname;
    const oldPath = req.file.path;
    const newPath = path.join(__dirname, 'uploads', originalName);
    fs.renameSync(oldPath, newPath);
  }
  res.redirect('/berkas-video');
});

app.post('/hapus-video', requireAuth, (req, res) => {
  const filename = req.body.filename;
  if (filename) {
    const filepath = path.join(__dirname, 'uploads', filename);
    if (fs.existsSync(filepath)) {
      try {
        fs.unlinkSync(filepath);
      } catch (e) {
        console.error("Error deleting file:", e);
      }
    }
  }
  res.redirect('/berkas-video');
});

app.post('/download-gdrive', requireAuth, (req, res) => {
    // Placeholder implementation for GDrive download to keep it simple
    // A real implementation would parse the Google Drive ID and pipe the request
    console.log("Mock Downloading GDrive URL:", req.body.url);
    res.redirect('/berkas-video?msg=Dalam_pengembangan');
});

// Init & Start
initCron();

app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
