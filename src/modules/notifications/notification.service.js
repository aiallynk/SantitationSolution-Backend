const { NotificationEvent } = require('../../models');
const { normalizePagination } = require('../../utils/validators');

const getMyNotifications = async (req) => {
  const { page, limit, offset } = normalizePagination(req.query, {
    page: 1,
    limit: 25,
    maxLimit: 100,
  });

  const { rows, count } = await NotificationEvent.findAndCountAll({
    where: {
      user_id: req.user.id,
    },
    order: [['created_at', 'DESC']],
    limit,
    offset,
  });

  return {
    items: rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      channel: row.channel,
      payload: row.payload,
      status: row.status,
      sentAt: row.sent_at,
      createdAt: row.created_at,
    })),
    meta: {
      page,
      limit,
      total: count,
      totalPages: Math.max(1, Math.ceil(count / limit)),
    },
  };
};

module.exports = {
  getMyNotifications,
};
