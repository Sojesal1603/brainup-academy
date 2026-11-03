const fs = require('fs');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const env = fs.readFileSync('.env', 'utf8');
const match = env.match(/GROQ_API_KEY=\"?([^\r\n\"]+)\"?/);
const key = match ? match[1] : null;

async function checkModels() {
  const res = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { 'Authorization': `Bearer ${key}` }
  });
  const data = await res.json();
  console.log('Groq models status:', res.status);
  if (data.data) {
    console.log('Available models:', data.data.map(m => m.id));
  } else {
    console.log('Error data:', data);
  }

  // Also test chat completion with first available model
  const model = data.data?.[0]?.id || 'llama-3.1-8b-instant';
  console.log('Testing completion with model:', model);
  const chatRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: model,
      messages: [{ role: 'user', content: 'Di hola' }]
    })
  });
  const chatData = await chatRes.json();
  console.log('Chat status:', chatRes.status);
  console.log('Chat reply:', chatData.choices?.[0]?.message?.content);
}

checkModels();
