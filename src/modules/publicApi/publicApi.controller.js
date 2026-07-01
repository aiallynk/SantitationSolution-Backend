const { sendSuccess } = require('../../core/http/response');
const publicToiletService = require('./publicToilet.service');

const getNearbyToilets = async (req, res, next) => {
  try {
    const result = await publicToiletService.getNearbyToilets(req);
    res.locals.publicResponseCount = result.items.length;
    return sendSuccess(res, {
      message: 'Nearby public toilets fetched successfully',
      data: result.items,
      meta: result.meta,
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  getNearbyToilets,
};
