import axios from 'axios';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { NetworkInfo } from 'react-native-network-info';
import {
  discoverPiUrl,
  fetchDistance,
  normalizeDistanceReading,
  setPiUrl,
} from '../src/api/piClient';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Maculus Pi client health handling', () => {
  it('keeps a reachable Pi response when its sensor endpoint returns HTTP 503', async () => {
    jest.spyOn(axios, 'get').mockRejectedValue({
      response: {
        status: 503,
        data: {
          distance_cm: null,
          obstacle: false,
          threshold_cm: 100,
          valid: false,
          healthy: false,
          error: 'Sensor has not produced a reading',
        },
      },
    });

    await expect(fetchDistance()).resolves.toMatchObject({
      valid: false,
      healthy: false,
      obstacle: false,
      error: 'Sensor has not produced a reading',
    });
  });

  it('recognizes legacy distance data as transport-compatible but not safety-valid', () => {
    expect(normalizeDistanceReading({
      distance_cm: 82,
      obstacle: true,
      threshold_cm: 100,
    })).toMatchObject({
      valid: false,
      healthy: false,
      obstacle: false,
      error: 'Pi sensor service must be updated to report valid and healthy fields',
    });
  });

  it('rejects unrelated JSON as a Maculus distance response', () => {
    expect(() => normalizeDistanceReading({ error: 'Not found' }))
      .toThrow('SENSOR_PROTOCOL_ERROR');
  });

  it('finds a Pi at an address outside the legacy common-host shortlist', async () => {
    setPiUrl('http://raspberrypi.local:8000');
    jest.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url === 'http://192.168.1.137:8000/status') {
        return {
          data: {
            system: 'Maculus Pi',
            camera: true,
            sensor: true,
            sensor_healthy: true,
          },
        } as any;
      }
      throw new Error('host unavailable');
    });

    await expect(discoverPiUrl(undefined, true))
      .resolves.toBe('http://192.168.1.137:8000');
  });

  it('finds a Pi connected to the iPhone Personal Hotspot without a Wi-Fi interface address', async () => {
    setPiUrl('http://raspberrypi.local:8000');
    jest.spyOn(NetworkInfo, 'getIPAddress').mockResolvedValue(null);
    jest.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url === 'http://172.20.10.2:8000/status') {
        return {
          data: {
            system: 'Maculus Pi',
            camera: true,
            sensor: true,
            sensor_healthy: true,
          },
        } as any;
      }
      throw new Error('host unavailable');
    });

    await expect(discoverPiUrl(undefined, false))
      .resolves.toBe('http://172.20.10.2:8000');
  });
});
