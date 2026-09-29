import { Router } from 'express';
import { Session } from '../models/Session.js';
import { User } from '../models/User.js';
import {
  emitLocationToRecipients,
  locationSharingRecipientIds,
  setLocationSharing,
  setLocationSharingRecipients,
  toLiveLocationPayload,
  updateSharedLocation,
} from '../services/location-sharing-service.js';
import { hashSessionToken } from '../services/session-service.js';

function extractBearerToken(request) {
  const authorization = request.get('authorization') || '';
  const [scheme, token] = authorization.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token.trim() : '';
}

async function authenticatedUser(request, response) {
  const accessToken = extractBearerToken(request);
  if (!accessToken) {
    response.status(401).json({ code: 'SESSION_INVALID', message: 'Phiên đăng nhập không hợp lệ.' });
    return null;
  }
  const session = await Session.findOne({
    accessTokenHash: hashSessionToken(accessToken),
    accessTokenExpiresAt: { $gt: new Date() },
  });
  if (!session) {
    response.status(401).json({ code: 'SESSION_INVALID', message: 'Phiên đăng nhập đã hết hạn.' });
    return null;
  }
  return User.findById(session.userId);
}

function unavailable(response) {
  return response.status(503).json({ code: 'DATABASE_UNAVAILABLE', message: 'Cơ sở dữ liệu đang tạm thời không khả dụng.' });
}

function sharingStatus(user) {
  return {
    enabled: user.locationSharingEnabled === true,
    hasConfigured: user.locationSharingHasBeenConfigured === true,
    recipientIds: locationSharingRecipientIds(user),
    updatedAt: user.sharedLocation?.updatedAt?.toISOString() ?? null,
  };
}

export function createLocationRouter({ isDatabaseReady, emitSocialEvent = () => undefined }) {
  const router = Router();

  router.get('/map/sharing', async (request, response) => {
    if (!isDatabaseReady()) return unavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      return response.json(sharingStatus(user));
    } catch (error) {
      console.error('Get map sharing status failed:', error);
      return response.status(500).json({ code: 'GET_LOCATION_SHARING_FAILED', message: 'Không thể tải trạng thái chia sẻ vị trí.' });
    }
  });

  router.patch('/map/sharing', async (request, response) => {
    if (!isDatabaseReady()) return unavailable(response);
    if (typeof request.body?.enabled !== 'boolean') {
      return response.status(422).json({ code: 'VALIDATION_ERROR', message: 'Trạng thái chia sẻ không hợp lệ.' });
    }
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const enabled = request.body.enabled;
      await setLocationSharing(user, enabled);
      if (!enabled) emitLocationToRecipients(user, emitSocialEvent, 'map:location-stopped', { userId: user._id.toString() });
      return response.json(sharingStatus(user));
    } catch (error) {
      console.error('Update map sharing status failed:', error);
      return response.status(500).json({ code: 'UPDATE_LOCATION_SHARING_FAILED', message: 'Không thể cập nhật chia sẻ vị trí.' });
    }
  });

  router.put('/map/sharing/recipients', async (request, response) => {
    if (!isDatabaseReady()) return unavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;

      const previousRecipientIds = locationSharingRecipientIds(user);
      const recipientIds = await setLocationSharingRecipients(user, request.body?.recipientIds);
      if (user.locationSharingEnabled) {
        const removedRecipientIds = previousRecipientIds.filter((recipientId) => !recipientIds.includes(recipientId));
        if (removedRecipientIds.length) {
          emitLocationToRecipients(user, emitSocialEvent, 'map:location-stopped', { userId: user._id.toString() }, removedRecipientIds);
        }
        const addedRecipientIds = recipientIds.filter((recipientId) => !previousRecipientIds.includes(recipientId));
        const location = toLiveLocationPayload(user);
        if (location && addedRecipientIds.length) {
          emitLocationToRecipients(user, emitSocialEvent, 'map:location-updated', location, addedRecipientIds);
        }
      }
      return response.json(sharingStatus(user));
    } catch (error) {
      const status = ['INVALID_LOCATION_RECIPIENTS', 'LOCATION_RECIPIENT_NOT_FRIEND'].includes(error?.code) ? 422 : 500;
      if (status === 500) console.error('Update location recipients failed:', error);
      return response.status(status).json({ code: error?.code || 'UPDATE_LOCATION_RECIPIENTS_FAILED', message: error.message || 'Không thể cập nhật người xem vị trí.' });
    }
  });

  router.post('/map/location', async (request, response) => {
    if (!isDatabaseReady()) return unavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;
      const location = await updateSharedLocation(user, request.body || {});
      if (location) emitLocationToRecipients(user, emitSocialEvent, 'map:location-updated', location);
      return response.json({ ok: true, location });
    } catch (error) {
      const status = error?.code === 'INVALID_LOCATION' ? 422 : error?.code === 'LOCATION_SHARING_DISABLED' ? 409 : 500;
      if (status === 500) console.error('Update shared location failed:', error);
      return response.status(status).json({ code: error?.code || 'UPDATE_LOCATION_FAILED', message: error.message || 'Không thể cập nhật vị trí.' });
    }
  });

  return router;
}
