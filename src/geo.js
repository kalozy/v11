const cache = new Map();
const TTL_MS = 30 * 60 * 1000; // 30 minutes

function getClientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return cf.trim();

  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();

  return req.ip || req.connection.remoteAddress || '127.0.0.1';
}

async function lookupIp(ip) {
  // Skip lookup for private/local IPs
  if (isPrivateIp(ip)) {
    return {
      country: 'XX',
      regionName: 'Local',
      city: 'Local',
      isp: 'Local',
      proxy: false,
      vpn: false,
      hosting: false,
      status: 'success'
    };
  }

  const cached = cache.get(ip);
  if (cached && Date.now() - cached.ts < TTL_MS) {
    return cached.data;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const res = await fetch(
      `http://ip-api.com/json/${ip}?fields=status,country,countryCode,regionName,city,isp,proxy,vpn,hosting`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`ip-api returned ${res.status}`);

    const data = await res.json();

    if (data.status !== 'success') {
      throw new Error('ip-api status: ' + data.status);
    }

    const result = {
      country: data.countryCode || 'XX',
      regionName: data.regionName || '',
      city: data.city || '',
      isp: data.isp || '',
      proxy: !!data.proxy,
      vpn: !!data.vpn,
      hosting: !!data.hosting,
      status: 'success'
    };

    cache.set(ip, { data: result, ts: Date.now() });
    return result;
  } catch (err) {
    // Fail open: do not block traffic on lookup error
    console.warn(`[geo] lookup failed for ${ip}: ${err.message}`);
    return {
      country: 'XX',
      regionName: '',
      city: '',
      isp: '',
      proxy: false,
      vpn: false,
      hosting: false,
      status: 'error'
    };
  }
}

function isPrivateIp(ip) {
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    ip.startsWith('172.16.') ||
    ip.startsWith('172.17.') ||
    ip.startsWith('172.18.') ||
    ip.startsWith('172.19.') ||
    ip.startsWith('172.2') ||
    ip.startsWith('172.30.') ||
    ip.startsWith('172.31.')
  );
}

// Periodic cleanup of expired cache entries
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of cache.entries()) {
    if (now - val.ts > TTL_MS) cache.delete(key);
  }
}, 5 * 60 * 1000);

module.exports = { getClientIp, lookupIp };
