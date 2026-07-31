'use strict';

require('dotenv').config();

const path = require('path');
const { sequelize } = require('../src/models');
const {
  applyApprovedMatches,
  loadReviewRows,
} = require('../src/modules/geography-master/india-district-reconciliation.service');

const parseArgs = (argv = process.argv.slice(2)) => {
  const args = { dryRun: true, apply: false, reviewFile: null };
  for (const arg of argv) {
    if (arg === '--apply') {
      args.apply = true;
      args.dryRun = false;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
      args.apply = false;
    } else if (arg.startsWith('--review-file=')) {
      args.reviewFile = arg.slice('--review-file='.length);
    }
  }
  if (args.reviewFile) args.reviewFile = path.resolve(process.cwd(), args.reviewFile);
  return args;
};

const main = async () => {
  const args = parseArgs();
  if (args.apply) {
    const applied = await applyApprovedMatches({ reviewFile: args.reviewFile });
    console.log(JSON.stringify({
      mode: 'apply',
      appliedCount: applied.length,
      applied,
    }, null, 2));
    return;
  }

  const reviewRows = await loadReviewRows();
  const safeAutomaticCandidates = reviewRows.filter((row) => row.confidence === 'high' && row.possibleLgdCandidates.length === 1);
  const manualReviewRows = reviewRows.filter((row) => !safeAutomaticCandidates.some((candidate) => candidate.globalGeographyId === row.globalGeographyId));
  console.log(JSON.stringify({
    mode: 'dry-run',
    mutated: false,
    totalGeoNamesOnlyDistricts: reviewRows.length,
    safeAutomaticCandidateCount: safeAutomaticCandidates.length,
    manualReviewCount: manualReviewRows.length,
    safeAutomaticCandidates,
    manualReviewRows,
  }, null, 2));
};

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => sequelize.close());
}

module.exports = { parseArgs };
