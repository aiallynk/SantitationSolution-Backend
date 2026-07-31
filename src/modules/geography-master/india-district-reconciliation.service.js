'use strict';

const fs = require('fs');
const { Op } = require('sequelize');
const {
  sequelize,
  Geography,
  GlobalGeographyAlias,
  GlobalGeographySource,
} = require('../../models');
const { normalizeName } = require('./normalization');

const KNOWN_RENAMED_DISTRICTS = new Map([
  ['maharashtra:ahmadnagar', 'ahilyanagar'],
  ['maharashtra:aurangabad', 'chhatrapati sambhajinagar'],
  ['maharashtra:osmanabad', 'dharashiv'],
]);

const stripDistrictSuffix = (value) => normalizeName(String(value || '').replace(/\bdistrict\b/gi, '').trim());

const isDivisionName = (value) => /\bdivision\b/i.test(String(value || ''));

const confidenceRank = {
  high: 3,
  medium: 2,
  low: 1,
  none: 0,
};

const bestCandidate = (candidates) => [...candidates].sort((left, right) => {
  const confidenceDelta = (confidenceRank[right.confidence] || 0) - (confidenceRank[left.confidence] || 0);
  if (confidenceDelta) return confidenceDelta;
  return String(left.name || '').localeCompare(String(right.name || ''));
})[0] || null;

const classifyLegacyDistrict = (legacy, candidates) => {
  if (isDivisionName(legacy.name)) {
    return {
      classification: 'administrative division rather than District',
      confidence: 'high',
      recommendedAction: 'keep hidden from official District dropdowns; review separately',
    };
  }

  const exact = candidates.find((candidate) => candidate.matchReason === 'same-state normalized name match');
  if (exact) {
    return {
      classification: 'exact renamed/alias match',
      confidence: 'high',
      recommendedAction: 'eligible for approved reconciliation if references are safe',
    };
  }

  const alias = candidates.find((candidate) => candidate.matchReason === 'same-state alias match');
  if (alias) {
    return {
      classification: 'exact renamed/alias match',
      confidence: 'high',
      recommendedAction: 'eligible for approved reconciliation after alias evidence review',
    };
  }

  if (candidates.length > 1) {
    return {
      classification: 'split/merged District requiring manual review',
      confidence: 'low',
      recommendedAction: 'manual review required; do not auto-apply',
    };
  }

  const renamed = candidates.find((candidate) => candidate.matchReason === 'known same-state rename');
  if (renamed) {
    return {
      classification: 'historical or superseded District',
      confidence: 'medium',
      recommendedAction: 'manual approval required before reconciliation',
    };
  }

  if (candidates.length === 1) {
    return {
      classification: 'unmatched',
      confidence: candidates[0].confidence,
      recommendedAction: 'manual review required before any child re-parenting',
    };
  }

  return {
    classification: 'unmatched',
    confidence: 'none',
    recommendedAction: 'leave hidden from official dropdowns and review manually',
  };
};

const loadReviewRows = async () => {
  const [legacyRows, candidateRows, aliasRows] = await Promise.all([
    sequelize.query(`
      SELECT
        g.id,
        g.name,
        g.normalized_name,
        g.parent_id,
        p.name AS state_name,
        g.preferred_external_code AS geonames_external_code,
        g.latitude,
        g.longitude,
        COUNT(DISTINCT child.id)::int AS child_place_count,
        COUNT(DISTINCT tenant_geo.id)::int AS tenant_geography_reference_count,
        COUNT(DISTINCT facility.id)::int AS facility_reference_count,
        (
          COUNT(DISTINCT platform_user.id) +
          COUNT(DISTINCT user_role.id) +
          COUNT(DISTINCT worker_assignment.id)
        )::int AS user_persona_reference_count
      FROM geographies g
      JOIN geographies p ON p.id = g.parent_id
      LEFT JOIN geographies child ON child.parent_id = g.id AND child.is_active = true AND child.level = 'city'
      LEFT JOIN geographies tenant_geo ON tenant_geo.tenant_id IS NOT NULL
        AND (tenant_geo.global_geography_id = g.id OR tenant_geo.master_geography_id = g.id)
      LEFT JOIN facilities facility ON facility.geography_id = g.id OR facility.geography_id = tenant_geo.id
      LEFT JOIN platform_users platform_user ON platform_user.geography_id = g.id OR platform_user.geography_id = tenant_geo.id
      LEFT JOIN user_roles user_role ON user_role.geography_id = g.id OR user_role.geography_id = tenant_geo.id
      LEFT JOIN worker_assignments worker_assignment ON worker_assignment.geography_id = g.id OR worker_assignment.geography_id = tenant_geo.id
      WHERE g.country_code = 'IN'
        AND g.level = 'district'
        AND g.is_active = true
        AND g.tenant_id IS NULL
        AND g.global_geography_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM global_geography_sources s
          WHERE s.global_geography_id = g.id AND s.source = 'LGD'
        )
      GROUP BY g.id, p.name
      ORDER BY p.name, g.name
    `, { type: sequelize.QueryTypes.SELECT }),
    sequelize.query(`
      SELECT
        g.id,
        g.name,
        g.normalized_name,
        g.parent_id,
        p.name AS state_name,
        s.external_code AS lgd_external_code,
        s.source_payload->>'lgdCode' AS lgd_code
      FROM geographies g
      JOIN geographies p ON p.id = g.parent_id
      JOIN global_geography_sources s ON s.global_geography_id = g.id AND s.source = 'LGD'
      WHERE g.country_code = 'IN'
        AND g.level = 'district'
        AND g.is_active = true
        AND g.tenant_id IS NULL
        AND g.global_geography_id IS NULL
      ORDER BY p.name, g.name
    `, { type: sequelize.QueryTypes.SELECT }),
    GlobalGeographyAlias.findAll({
      attributes: ['global_geography_id', 'name', 'normalized_name'],
      raw: true,
    }),
  ]);

  const aliasesByGeographyId = new Map();
  for (const alias of aliasRows) {
    const key = String(alias.global_geography_id);
    const list = aliasesByGeographyId.get(key) || [];
    list.push(alias.normalized_name || normalizeName(alias.name));
    aliasesByGeographyId.set(key, list);
  }

  const candidatesByParent = new Map();
  for (const candidate of candidateRows) {
    const list = candidatesByParent.get(String(candidate.parent_id)) || [];
    list.push(candidate);
    candidatesByParent.set(String(candidate.parent_id), list);
  }

  return legacyRows.map((legacy) => {
    const stateKey = `${normalizeName(legacy.state_name)}:${stripDistrictSuffix(legacy.name)}`;
    const knownRename = KNOWN_RENAMED_DISTRICTS.get(stateKey);
    const possibleCandidates = (candidatesByParent.get(String(legacy.parent_id)) || [])
      .map((candidate) => {
        const candidateAliases = aliasesByGeographyId.get(String(candidate.id)) || [];
        const legacyNormalized = legacy.normalized_name || normalizeName(legacy.name);
        const legacyStripped = stripDistrictSuffix(legacy.name);
        const candidateNormalized = candidate.normalized_name || normalizeName(candidate.name);
        const candidateStripped = stripDistrictSuffix(candidate.name);
        let matchReason = null;
        let confidence = 'low';
        if (legacyNormalized === candidateNormalized || legacyStripped === candidateStripped) {
          matchReason = 'same-state normalized name match';
          confidence = 'high';
        } else if (candidateAliases.includes(legacyNormalized) || candidateAliases.includes(legacyStripped)) {
          matchReason = 'same-state alias match';
          confidence = 'high';
        } else if (knownRename && knownRename === candidateStripped) {
          matchReason = 'known same-state rename';
          confidence = 'medium';
        } else if (
          candidateStripped.includes(legacyStripped) ||
          legacyStripped.includes(candidateStripped)
        ) {
          matchReason = 'same-state partial name overlap';
          confidence = 'low';
        }
        return matchReason ? {
          id: candidate.id,
          name: candidate.name,
          normalizedName: candidate.normalized_name,
          lgdExternalCode: candidate.lgd_external_code,
          lgdCode: candidate.lgd_code,
          matchReason,
          confidence,
        } : null;
      })
      .filter(Boolean);
    const classification = classifyLegacyDistrict(legacy, possibleCandidates);
    return {
      globalGeographyId: legacy.id,
      name: legacy.name,
      normalizedName: legacy.normalized_name,
      stateParent: legacy.state_name,
      parentId: legacy.parent_id,
      geonamesExternalCode: legacy.geonames_external_code,
      latitude: legacy.latitude,
      longitude: legacy.longitude,
      childPlaceCount: legacy.child_place_count,
      tenantGeographyReferenceCount: legacy.tenant_geography_reference_count,
      facilityReferenceCount: legacy.facility_reference_count,
      userPersonaReferenceCount: legacy.user_persona_reference_count,
      possibleLgdCandidates: possibleCandidates,
      matchingReason: bestCandidate(possibleCandidates)?.matchReason || 'no same-state LGD candidate found',
      confidence: classification.confidence,
      classification: classification.classification,
      recommendedAction: classification.recommendedAction,
    };
  });
};

const loadApprovedMatches = (reviewFile) => {
  if (!reviewFile) throw new Error('--review-file is required when --apply is used');
  const payload = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
  const rows = Array.isArray(payload) ? payload : payload.approvedMatches;
  if (!Array.isArray(rows)) throw new Error('Review file must be an array or contain approvedMatches[]');
  return rows.filter((row) => row && row.approved === true && row.action === 'reconcile');
};

const applyApprovedMatches = async ({ reviewFile }) => {
  const approvals = loadApprovedMatches(reviewFile);
  const results = [];
  for (const approval of approvals) {
    const legacyId = approval.legacyGlobalGeographyId || approval.globalGeographyId;
    const canonicalId = approval.canonicalLgdDistrictId || approval.candidateGlobalGeographyId;
    if (!legacyId || !canonicalId) throw new Error('Each approval requires legacyGlobalGeographyId and canonicalLgdDistrictId');

    const result = await sequelize.transaction(async (transaction) => {
      const [legacy, canonical] = await Promise.all([
        Geography.findByPk(legacyId, { transaction }),
        Geography.findByPk(canonicalId, { transaction }),
      ]);
      if (!legacy || !canonical) throw new Error(`Missing legacy or canonical geography for ${legacyId} -> ${canonicalId}`);
      if (legacy.level !== 'district' || canonical.level !== 'district') throw new Error('Only district-to-district reconciliation is supported');
      if (legacy.country_code !== 'IN' || canonical.country_code !== 'IN') throw new Error('Only India district reconciliation is supported');
      if (String(legacy.parent_id) !== String(canonical.parent_id)) throw new Error(`Cross-State reconciliation rejected for ${legacy.name}`);

      const canonicalLgdSource = await GlobalGeographySource.findOne({
        where: { global_geography_id: canonical.id, source: 'LGD' },
        transaction,
      });
      if (!canonicalLgdSource) throw new Error(`Canonical district ${canonical.id} is not LGD-backed`);
      const legacyLgdSource = await GlobalGeographySource.findOne({
        where: { global_geography_id: legacy.id, source: 'LGD' },
        transaction,
      });
      if (legacyLgdSource) throw new Error(`Legacy district ${legacy.id} already has an LGD source`);

      const children = await Geography.findAll({
        where: { parent_id: legacy.id, country_code: 'IN', level: 'city' },
        attributes: ['id', 'parent_id', 'country_code'],
        transaction,
      });
      await Geography.update({ parent_id: canonical.id }, {
        where: { id: { [Op.in]: children.map((child) => child.id) } },
        transaction,
      });

      const legacySources = await GlobalGeographySource.findAll({
        where: { global_geography_id: legacy.id },
        transaction,
      });
      let transferredSources = 0;
      for (const source of legacySources) {
        const duplicate = await GlobalGeographySource.findOne({
          where: {
            source: source.source,
            external_code: source.external_code,
            global_geography_id: canonical.id,
          },
          transaction,
        });
        if (!duplicate) {
          await source.update({ global_geography_id: canonical.id, is_preferred: false }, { transaction });
          transferredSources += 1;
        }
      }

      await GlobalGeographyAlias.findOrCreate({
        where: {
          global_geography_id: canonical.id,
          normalized_name: normalizeName(legacy.name),
        },
        defaults: {
          name: legacy.name,
          source: 'RECONCILIATION',
          external_code: legacy.preferred_external_code || legacy.external_code || legacy.id,
        },
        transaction,
      });

      await legacy.update({
        quality_status: approval.legacyStatus || 'superseded',
        is_platform_managed: true,
        is_official_source: false,
        is_verified_local_government: false,
      }, { transaction });

      return {
        legacyGlobalGeographyId: legacy.id,
        legacyName: legacy.name,
        canonicalLgdDistrictId: canonical.id,
        canonicalName: canonical.name,
        movedChildPlaceCount: children.length,
        transferredSources,
        legacyStatus: approval.legacyStatus || 'superseded',
      };
    });
    results.push(result);
  }
  return results;
};

module.exports = {
  classifyLegacyDistrict,
  loadReviewRows,
  applyApprovedMatches,
};
