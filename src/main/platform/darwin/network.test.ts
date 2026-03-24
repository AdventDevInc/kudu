import { describe, it, expect, vi, beforeEach } from 'vitest'

const execFileMock = vi.fn()
vi.mock('child_process', () => ({
  execFile: execFileMock,
}))
vi.mock('util', () => ({
  promisify: (fn: any) => fn,
}))

const { createDarwinNetwork } = await import('./network')

describe('darwin network', () => {
  const network = createDarwinNetwork()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getEstablishedConnections', () => {
    it('parses lsof output for IPv4 connections', async () => {
      execFileMock.mockResolvedValue({
        stdout: [
          'p1234',
          'n10.0.0.5:45678->93.184.216.34:443',
        ].join('\n'),
      })

      const conns = await network.getEstablishedConnections()
      expect(conns).toHaveLength(1)
      expect(conns[0]).toEqual({
        remoteAddress: '93.184.216.34',
        remotePort: 443,
        localPort: 45678,
        pid: 1234,
      })
    })

    it('parses IPv6 connections', async () => {
      execFileMock.mockResolvedValue({
        stdout: [
          'p5678',
          'n[::ffff:10.0.0.1]:8080->[2607:f8b0:4004:800::200e]:443',
        ].join('\n'),
      })

      const conns = await network.getEstablishedConnections()
      expect(conns).toHaveLength(1)
      expect(conns[0].remoteAddress).toBe('2607:f8b0:4004:800::200e')
      expect(conns[0].remotePort).toBe(443)
      expect(conns[0].localPort).toBe(8080)
      expect(conns[0].pid).toBe(5678)
    })

    it('filters out loopback connections', async () => {
      execFileMock.mockResolvedValue({
        stdout: [
          'p100',
          'n10.0.0.1:1234->127.0.0.1:5678',
          'n10.0.0.1:1235->93.184.216.34:80',
        ].join('\n'),
      })

      const conns = await network.getEstablishedConnections()
      expect(conns).toHaveLength(1)
      expect(conns[0].remoteAddress).toBe('93.184.216.34')
    })

    it('filters out ::1 loopback', async () => {
      execFileMock.mockResolvedValue({
        stdout: 'p100\nn[::1]:1234->[::1]:5678\n',
      })

      const conns = await network.getEstablishedConnections()
      expect(conns).toHaveLength(0)
    })

    it('skips lines without arrow separator', async () => {
      execFileMock.mockResolvedValue({
        stdout: 'p100\nn*:8080\n',
      })

      const conns = await network.getEstablishedConnections()
      expect(conns).toHaveLength(0)
    })

    it('returns empty array on failure', async () => {
      execFileMock.mockRejectedValue(new Error('fail'))
      const conns = await network.getEstablishedConnections()
      expect(conns).toEqual([])
    })

    it('associates pid with subsequent connection lines', async () => {
      execFileMock.mockResolvedValue({
        stdout: [
          'p111',
          'n10.0.0.1:1000->8.8.8.8:53',
          'p222',
          'n10.0.0.1:2000->1.1.1.1:443',
        ].join('\n'),
      })

      const conns = await network.getEstablishedConnections()
      expect(conns).toHaveLength(2)
      expect(conns[0].pid).toBe(111)
      expect(conns[1].pid).toBe(222)
    })

    it('handles empty lines gracefully', async () => {
      execFileMock.mockResolvedValue({
        stdout: '\np100\n\nn10.0.0.1:80->8.8.4.4:443\n\n',
      })

      const conns = await network.getEstablishedConnections()
      expect(conns).toHaveLength(1)
    })
  })

  describe('getListeningPorts', () => {
    it('parses listening port numbers from lsof output', async () => {
      execFileMock.mockResolvedValue({
        stdout: 'n*:8080\nn*:3000\nn[::]:443\n',
      })

      const ports = await network.getListeningPorts()
      expect(ports).toContain(8080)
      expect(ports).toContain(3000)
      expect(ports).toContain(443)
    })

    it('skips non-n lines', async () => {
      execFileMock.mockResolvedValue({
        stdout: 'p1234\nn*:8080\nfoo\n',
      })

      const ports = await network.getListeningPorts()
      expect(ports).toEqual([8080])
    })

    it('returns empty array on failure', async () => {
      execFileMock.mockRejectedValue(new Error('fail'))
      const ports = await network.getListeningPorts()
      expect(ports).toEqual([])
    })

    it('skips invalid port numbers', async () => {
      execFileMock.mockResolvedValue({
        stdout: 'n*:abc\nn*:8080\n',
      })

      const ports = await network.getListeningPorts()
      expect(ports).toEqual([8080])
    })
  })

  describe('getDnsCacheEntries', () => {
    it('returns empty array (not available on macOS)', async () => {
      const entries = await network.getDnsCacheEntries()
      expect(entries).toEqual([])
    })
  })

  describe('flushDnsCache', () => {
    it('calls dscacheutil and kills mDNSResponder', async () => {
      execFileMock.mockResolvedValue({ stdout: '' })
      const result = await network.flushDnsCache()
      expect(result).toBe(true)
      expect(execFileMock).toHaveBeenCalledWith(
        '/usr/bin/dscacheutil', ['-flushcache'], expect.any(Object),
      )
      expect(execFileMock).toHaveBeenCalledWith(
        '/usr/bin/killall', ['-HUP', 'mDNSResponder'], expect.any(Object),
      )
    })

    it('returns false on dscacheutil failure', async () => {
      execFileMock.mockRejectedValue(new Error('fail'))
      const result = await network.flushDnsCache()
      expect(result).toBe(false)
    })

    it('succeeds even if killall mDNSResponder fails', async () => {
      execFileMock
        .mockResolvedValueOnce({ stdout: '' })     // dscacheutil
        .mockRejectedValueOnce(new Error('no match')) // killall

      const result = await network.flushDnsCache()
      expect(result).toBe(true)
    })
  })

  describe('getWifiProfiles', () => {
    it('parses wifi profile names from networksetup output', async () => {
      execFileMock.mockResolvedValue({
        stdout: [
          'Preferred networks on en0:',
          '\tHomeNetwork',
          '\tOfficeWiFi',
          '\tCoffeeShop',
        ].join('\n'),
      })

      const profiles = await network.getWifiProfiles()
      expect(profiles).toHaveLength(3)
      expect(profiles[0].name).toBe('HomeNetwork')
      expect(profiles[1].name).toBe('OfficeWiFi')
      expect(profiles[2].name).toBe('CoffeeShop')
      expect(profiles[0].security).toBe('Wi-Fi')
    })

    it('skips the header line', async () => {
      execFileMock.mockResolvedValue({
        stdout: 'Preferred networks on en0:\n\tMyNetwork\n',
      })

      const profiles = await network.getWifiProfiles()
      expect(profiles).toHaveLength(1)
      expect(profiles[0].name).toBe('MyNetwork')
    })

    it('skips empty lines', async () => {
      execFileMock.mockResolvedValue({
        stdout: 'Preferred networks on en0:\n\tMyNetwork\n\n\n',
      })

      const profiles = await network.getWifiProfiles()
      expect(profiles).toHaveLength(1)
    })

    it('returns empty array on failure', async () => {
      execFileMock.mockRejectedValue(new Error('fail'))
      const profiles = await network.getWifiProfiles()
      expect(profiles).toEqual([])
    })
  })

  describe('deleteWifiProfile', () => {
    it('calls networksetup to remove the profile', async () => {
      execFileMock.mockResolvedValue({ stdout: '' })
      const result = await network.deleteWifiProfile('CoffeeShop')
      expect(result).toBe(true)
      expect(execFileMock).toHaveBeenCalledWith(
        '/usr/sbin/networksetup',
        ['-removepreferredwirelessnetwork', 'en0', 'CoffeeShop'],
        expect.any(Object),
      )
    })

    it('returns false on failure', async () => {
      execFileMock.mockRejectedValue(new Error('fail'))
      const result = await network.deleteWifiProfile('BadNetwork')
      expect(result).toBe(false)
    })
  })

  describe('clearArpCache', () => {
    it('calls arp -a -d', async () => {
      execFileMock.mockResolvedValue({ stdout: '' })
      const result = await network.clearArpCache()
      expect(result).toBe(true)
      expect(execFileMock).toHaveBeenCalledWith(
        '/usr/sbin/arp', ['-a', '-d'], expect.any(Object),
      )
    })

    it('returns false on failure', async () => {
      execFileMock.mockRejectedValue(new Error('fail'))
      const result = await network.clearArpCache()
      expect(result).toBe(false)
    })
  })
})
