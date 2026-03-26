const bcrypt = require('bcrypt');
const { Op } = require('sequelize');
const User = require('../modules/users/user.model');
const Inspection = require('../modules/inspections/inspection.model');
const Alert = require('../modules/alerts/alert.model');

const DEMO_MIN_INSPECTIONS = Number.parseInt(process.env.DEMO_MIN_INSPECTIONS, 10) || 12;

const deriveSeverity = (score) => {
  if (score <= 40) return 'critical';
  if (score <= 60) return 'poor';
  if (score <= 75) return 'moderate';
  if (score <= 90) return 'good';
  return 'excellent';
};

const createBreakdown = (scoreBefore, scoreAfter) => {
  const delta = Math.max(5, Math.round((scoreAfter - scoreBefore) / 3));

  const buildMetric = (beforeValue, extraAfter = 0) => {
    const afterValue = Math.min(98, beforeValue + delta + extraAfter);
    return {
      before: beforeValue,
      after: afterValue,
      improvement: afterValue - beforeValue,
    };
  };

  return {
    floorCleanliness: buildMetric(Math.max(25, scoreBefore - 6), 4),
    wallCleanliness: buildMetric(Math.max(25, scoreBefore - 3), 2),
    wetnessControl: buildMetric(Math.max(25, scoreBefore - 8), 1),
    litterControl: buildMetric(Math.max(25, scoreBefore - 5), 3),
    odourRisk: buildMetric(Math.max(25, scoreBefore - 4), 2),
  };
};

const createFindings = (scoreBefore, scoreAfter) => {
  const findings = [
    'Wet floor detected before cleaning',
    'Visible litter detected',
    'Stain presence reduced after cleaning',
    'Odour risk improved',
    'Cleaning improvement verified',
  ];

  if (scoreAfter - scoreBefore < 18) {
    return findings.slice(1);
  }

  return findings;
};

const ensureUser = async ({ username, password, role }) => {
  const existingUser = await User.findOne({ where: { username } });

  if (existingUser) {
    return existingUser;
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  return User.create({
    username,
    password: hashedPassword,
    role,
  });
};

const seedUsers = async () => {
  const admin = await ensureUser({
    username: 'admin',
    password: 'admin123',
    role: 'ADMIN',
  });

  const worker1 = await ensureUser({
    username: 'worker1',
    password: 'worker123',
    role: 'WORKER',
  });

  const worker2 = await ensureUser({
    username: 'worker2',
    password: 'worker123',
    role: 'WORKER',
  });

  return { admin, worker1, worker2 };
};

const buildDemoInspectionTemplates = (workers) => {
  const now = new Date();
  const workerIds = [workers.worker1.id, workers.worker2.id];

  const locations = [
    { code: 'NSK-T-001', name: 'CBS Bus Stand Toilet', city: 'Nashik', ward: 'Ward 12', zone: 'Central', sector: 'Sector A', lat: 19.9971, lng: 73.7895 },
    { code: 'NSK-T-002', name: 'Panchavati Ghat Public Toilet', city: 'Nashik', ward: 'Ward 08', zone: 'North', sector: 'Sector B', lat: 20.0105, lng: 73.7904 },
    { code: 'NSK-T-003', name: 'Dwarka Circle Facility', city: 'Nashik', ward: 'Ward 16', zone: 'West', sector: 'Sector C', lat: 19.9923, lng: 73.8032 },
    { code: 'NSK-T-004', name: 'CIDCO Market Restroom', city: 'Nashik', ward: 'Ward 23', zone: 'East', sector: 'Sector D', lat: 19.9764, lng: 73.7571 },
    { code: 'NSK-T-005', name: 'College Road Public Utility', city: 'Nashik', ward: 'Ward 14', zone: 'Central', sector: 'Sector E', lat: 19.9997, lng: 73.7732 },
    { code: 'NSK-T-006', name: 'Satpur MIDC Gate Toilet', city: 'Nashik', ward: 'Ward 04', zone: 'West', sector: 'Sector F', lat: 19.9692, lng: 73.7334 },
    { code: 'NSK-T-007', name: 'Mhasrul Stand Facility', city: 'Nashik', ward: 'Ward 10', zone: 'North', sector: 'Sector G', lat: 20.0218, lng: 73.7765 },
    { code: 'NSK-T-008', name: 'Sharanpur Road Public Toilet', city: 'Nashik', ward: 'Ward 15', zone: 'Central', sector: 'Sector H', lat: 19.9941, lng: 73.7838 },
    { code: 'NSK-T-009', name: 'Ambad Link Road Facility', city: 'Nashik', ward: 'Ward 20', zone: 'South', sector: 'Sector I', lat: 19.9538, lng: 73.7426 },
    { code: 'NSK-T-010', name: 'Nashik Road Station Toilet', city: 'Nashik', ward: 'Ward 29', zone: 'South', sector: 'Sector J', lat: 19.9544, lng: 73.8469 },
    { code: 'NSK-T-011', name: 'Gangapur Naka Utility', city: 'Nashik', ward: 'Ward 18', zone: 'West', sector: 'Sector K', lat: 19.9868, lng: 73.7613 },
    { code: 'NSK-T-012', name: 'Trimbak Road Public Toilet', city: 'Nashik', ward: 'Ward 05', zone: 'West', sector: 'Sector L', lat: 19.9829, lng: 73.7475 },
  ];

  const profiles = [
    { status: 'completed', before: 41, after: 84 },
    { status: 'completed', before: 56, after: 88 },
    { status: 'completed', before: 49, after: 78 },
    { status: 'completed', before: 58, after: 92 },
    { status: 'completed', before: 38, after: 68 },
    { status: 'completed', before: 44, after: 74 },
    { status: 'completed', before: 52, after: 90 },
    { status: 'completed', before: 47, after: 71 },
    { status: 'completed', before: 55, after: 95 },
    { status: 'processing', before: null, after: null },
    { status: 'pending', before: null, after: null },
    { status: 'failed', before: null, after: null },
  ];

  return locations.map((location, index) => {
    const profile = profiles[index];
    const createdAt = new Date(now);
    createdAt.setDate(now.getDate() - (locations.length - index));

    let scoreBefore = null;
    let scoreAfter = null;
    let improvementScore = null;
    let overallScore = null;
    let severity = null;
    let findingsJson = null;
    let scoreBreakdownJson = null;
    let processedAt = null;
    let remarks = 'Routine sanitation check for demo dashboard';

    if (profile.status === 'completed') {
      scoreBefore = profile.before;
      scoreAfter = profile.after;
      improvementScore = profile.after - profile.before;
      overallScore = Math.max(0, Math.min(100, Math.round((scoreAfter * 0.7) + (improvementScore * 0.3))));
      severity = deriveSeverity(overallScore);
      findingsJson = JSON.stringify(createFindings(scoreBefore, scoreAfter));
      scoreBreakdownJson = JSON.stringify(createBreakdown(scoreBefore, scoreAfter));
      processedAt = new Date(createdAt.getTime() + 1000 * 60 * 3);
    }

    if (profile.status === 'failed') {
      remarks = 'Processing failed due to temporary connectivity issue';
    }

    return {
      worker_id: workerIds[index % workerIds.length],
      toilet_code: location.code,
      toilet_name: location.name,
      city: location.city,
      ward: location.ward,
      zone: location.zone,
      sector: location.sector,
      latitude: location.lat,
      longitude: location.lng,
      before_image_url: `https://res.cloudinary.com/demo/image/upload/v1700000000/ecovision/demo-before-${index + 1}.jpg`,
      after_image_url: profile.status === 'completed'
        ? `https://res.cloudinary.com/demo/image/upload/v1700000000/ecovision/demo-after-${index + 1}.jpg`
        : null,
      image_url: `https://res.cloudinary.com/demo/image/upload/v1700000000/ecovision/demo-before-${index + 1}.jpg`,
      score_before: scoreBefore,
      score_after: scoreAfter,
      improvement_score: improvementScore,
      overall_score: overallScore,
      score: overallScore,
      severity,
      status: profile.status,
      findings_json: findingsJson,
      score_breakdown_json: scoreBreakdownJson,
      remarks,
      processed_at: processedAt,
      created_at: createdAt,
    };
  });
};

const seedInspections = async (workers) => {
  const existingCount = await Inspection.count();

  if (existingCount >= DEMO_MIN_INSPECTIONS) {
    return;
  }

  const needed = DEMO_MIN_INSPECTIONS - existingCount;
  const templates = buildDemoInspectionTemplates(workers).slice(0, needed);

  if (templates.length > 0) {
    await Inspection.bulkCreate(templates);
  }
};

const seedAlerts = async () => {
  const targetAlerts = 5;
  const existingCount = await Alert.count();

  if (existingCount >= targetAlerts) {
    return;
  }

  const inspections = await Inspection.findAll({
    where: {
      status: 'completed',
      overall_score: {
        [Op.lte]: 60,
      },
    },
    order: [['overall_score', 'ASC']],
    raw: true,
  });

  if (inspections.length === 0) {
    return;
  }

  const existingInspectionAlerts = await Alert.findAll({
    attributes: ['inspection_id'],
    raw: true,
  });

  const alertedInspectionIds = new Set(existingInspectionAlerts.map((item) => item.inspection_id));
  const statuses = ['open', 'acknowledged', 'resolved'];

  const alertsToCreate = [];
  for (let i = 0; i < inspections.length; i += 1) {
    if (existingCount + alertsToCreate.length >= targetAlerts) {
      break;
    }

    const inspection = inspections[i];
    if (alertedInspectionIds.has(inspection.id)) {
      continue;
    }

    alertsToCreate.push({
      inspection_id: inspection.id,
      severity: inspection.overall_score <= 40 ? 'critical' : 'poor',
      status: statuses[i % statuses.length],
      message: `Attention required at ${inspection.toilet_name} (overall score: ${inspection.overall_score})`,
      created_at: inspection.created_at,
    });
  }

  if (alertsToCreate.length > 0) {
    await Alert.bulkCreate(alertsToCreate);
  }
};

const seedDemoData = async () => {
  try {
    const workers = await seedUsers();
    await seedInspections(workers);
    await seedAlerts();
  } catch (error) {
    console.error('Demo seed failed:', error.message);
  }
};

module.exports = {
  seedUsers,
  seedDemoData,
};
