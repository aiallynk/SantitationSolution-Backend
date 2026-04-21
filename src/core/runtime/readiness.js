let isReady = false;
let readinessReason = 'booting';
let readySince = null;

const markReady = (reason = 'ready') => {
  isReady = true;
  readinessReason = String(reason || 'ready');
  readySince = new Date().toISOString();
};

const markNotReady = (reason = 'not_ready') => {
  isReady = false;
  readinessReason = String(reason || 'not_ready');
};

const getReadinessState = () => ({
  ready: isReady,
  reason: readinessReason,
  readySince,
});

module.exports = {
  markReady,
  markNotReady,
  getReadinessState,
};
