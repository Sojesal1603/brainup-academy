const fs = require('fs');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const env = fs.readFileSync('.env', 'utf8');
const match = env.match(/GEMINI_API_KEY=\"?([^\r\n\"]+)\"?/);
const key = match ? match[1] : null;

async function checkGemini() {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
  const data = await res.json();
  console.log('Gemini status:', res.status);
  if (data.models) {
    console.log('Gemini models:', data.models.slice(0, 10).map(m => m.name));
  } else {
    console.log('Gemini error:', data);
  }
}

checkGemini();
