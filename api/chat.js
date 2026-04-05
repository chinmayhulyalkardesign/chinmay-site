module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Log every question asked
    const messages = req.body.messages || [];
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role === 'user') {
      const content = Array.isArray(lastMessage.content)
        ? lastMessage.content.find(c => c.type === 'text')?.text || '[file uploaded]'
        : lastMessage.content;
      console.log(`[QUESTION] ${new Date().toISOString()} — ${content}`);
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: 'Something went wrong', detail: err.message });
  }
}
