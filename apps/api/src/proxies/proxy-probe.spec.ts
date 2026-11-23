import { describe, expect, it } from 'vitest';
import { parseEchoResponse } from './proxy-probe.service.js';

describe('parseEchoResponse', () => {
  it('reads the IP from ipify JSON', () => {
    expect(parseEchoResponse('{"ip":"198.51.100.7"}')).toEqual({
      exitIp: '198.51.100.7',
    });
  });

  it('reads a country when the same answer carries one', () => {
    expect(parseEchoResponse('{"ip":"2001:db8::1","country":"de"}')).toEqual({
      exitIp: '2001:db8::1',
      country: 'DE',
    });
  });

  it('reads plain-text icanhazip answers with a trailing newline', () => {
    expect(parseEchoResponse('198.51.100.7\n')).toEqual({
      exitIp: '198.51.100.7',
    });
  });

  it('ignores a captive portal or any other non-IP body', () => {
    expect(parseEchoResponse('<html>login</html>')).toEqual({});
    expect(parseEchoResponse('{"ip":"not-an-ip"}')).toEqual({});
    expect(parseEchoResponse('999.1.1.1')).toEqual({});
    expect(parseEchoResponse('')).toEqual({});
  });
});
