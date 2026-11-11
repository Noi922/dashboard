'use strict';
// Startet das Dashboard mit simulierten Daten: npm run demo
process.env.MOCK_PORT ||= '9999';
process.env.TRUENAS_HOST = `localhost:${process.env.MOCK_PORT}`;
process.env.TRUENAS_WS_SCHEME = 'ws';
process.env.TRUENAS_API_KEY = 'demo';
process.env.ENABLE_ACTIONS ||= 'true';
const base = `http://localhost:${process.env.MOCK_PORT}`;
process.env.DEMO_MAIL = '1';
process.env.CALENDAR_URLS = `Privat|${base}/privat.ics,Arbeit|${base}/arbeit.ics`;
process.env.NEWS_FEEDS = `${base}/feed.xml`;
process.env.WEATHER_URL = `${base}/weather`;
process.env.WEATHER_LAT = '52.52';
process.env.WEATHER_LON = '13.41';
process.env.WEATHER_NAME = 'Berlin';
require('./mock-truenas.js');
require('../server.js');
