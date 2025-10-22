import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { z } from 'zod';

// Create an MCP server
const server = new McpServer({
  name: 'demo-server',
  version: '1.0.0'
});

// Add an addition tool
server.registerTool(
  'add',
  {
    title: 'Addition Tool',
    description: 'Add two numbers',
    inputSchema: { a: z.number(), b: z.number() },
    outputSchema: { result: z.number() }
  },
  async ({ a, b }) => {
    const output = { result: a + b };
    return {
      content: [{ type: 'text', text: JSON.stringify(output) }],
      structuredContent: output
    };
  }
);

server.registerTool('getWeather', {
  title: 'Get weather tool',
  description: 'Tool to get the weather for a city',
  inputSchema: { city: z.string().describe('The name of the city to get the weather for') },
  outputSchema: { result: z.string() }
},
  async ({ city }) => {
    const response = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${city}&count=10&language=en&format=json`);
    const data = await response.json();

    if (!data.results || data.results.length === 0) {
      const output = { result: `City ${city} not found.` };
      return {
        content: [{ type: 'text', text: output.result }],
        structuredContent: output
      };
    }

    const { latitude, longitude } = data.results[0];
    const weatherResponse = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&hourly=temperature_2m&current=temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation,rain,showers,cloud_cover,apparent_temperature`);
    const weatherData = await weatherResponse.json();

    const current = weatherData.current;
    const currentInfo = `Temperature: ${current.temperature_2m}°C\n` +
      `Humidity: ${current.relative_humidity_2m}%\n` +
      `Wind: ${current.wind_speed_10m} km/h\n` +
      `Precipitation: ${current.precipitation} mm\n` +
      `Cloud Cover: ${current.cloud_cover}%`;

    const output = { result: currentInfo };

    return {
      content: [
        { type: 'text', text: currentInfo }
      ],
      structuredContent: output
    };
  });


// Add a dynamic greeting resource
server.registerResource(
  'greeting',
  new ResourceTemplate('greeting://{name}', { list: undefined }),
  {
    title: 'Greeting Resource', // Display name for UI
    description: 'Dynamic greeting generator'
  },
  async (uri, { name }) => ({
    contents: [
      {
        uri: uri.href,
        text: `Hello, ${name}!`
      }
    ]
  })
);

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const clientKey = req.headers['x-mcp-key'];
  if (clientKey !== process.env.MCP_PRIVATE_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
})

app.post('/mcp', async (req, res) => {
  // Create a new transport for each request to prevent request ID collisions
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });

  res.on('close', () => {
    transport.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const transports = {
  streamable: {} as Record<string, StreamableHTTPServerTransport>,
  sse: {} as Record<string, SSEServerTransport>
};

app.get('/sse', async (req, res) => {
  // Create SSE transport for legacy clients
  const transport = new SSEServerTransport('/messages', res);
  transports.sse[transport.sessionId] = transport;

  res.on('close', () => {
    delete transports.sse[transport.sessionId];
  });

  await server.connect(transport);
});

// Legacy message endpoint for older clients
app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports.sse[sessionId];
  if (transport) {
    await transport.handlePostMessage(req, res, req.body);
  } else {
    res.status(400).send('No transport found for sessionId');
  }
});

const port = parseInt(process.env.PORT || '3000');
app.listen(port, () => {
  console.log(`Demo MCP Server running on http://localhost:${port}/mcp`);
}).on('error', error => {
  process.exit(1);
});