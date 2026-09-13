import { expect, it } from 'vitest'
import { resolve } from 'path'
import { parseMountInfo } from './mount-points'

it('lists mount points from mountinfo, decoding escaped characters', () => {
  const text = [
    '22 28 0:21 / /proc rw,nosuid shared:5 - proc proc rw',
    '96 28 8:1 /srv/data /home/user/project/data rw,relatime shared:1 - ext4 /dev/sda1 rw',
    '97 28 8:1 /srv/with\\040space /mnt/with\\040space rw - ext4 /dev/sda1 rw',
    'garbage line'
  ].join('\n')
  const points = parseMountInfo(text)
  expect(points.has(resolve('/proc'))).toBe(true)
  expect(points.has(resolve('/home/user/project/data'))).toBe(true)
  expect(points.has(resolve('/mnt/with space'))).toBe(true)
  expect(points.size).toBe(3)
})
