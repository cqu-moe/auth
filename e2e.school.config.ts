import base from './e2e.config';
export default {
  ...base,
  tests: ['e2e/school/journey.school.ts'],
  timeout: 600000,
  assertionTimeout: 90000,
  credentials: { ...base.credentials, school: { username: '20990001', password: 'School-synthetic-123!' } },
};
