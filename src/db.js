const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');

const adapter = new FileSync(path.join(__dirname, '../data/db.json'));
const db = low(adapter);

// Setup default data
db.defaults({
  tasks: [],
  upload_tasks: [],
  videos: [],
  youtube_channels: [],
  settings: {
    password: 'admin',
    timezone: 'Asia/Jakarta',
    youtube_client_id: '',
    youtube_client_secret: '',
    youtube_redirect_uri: ''
  }
}).write();

module.exports = db;
