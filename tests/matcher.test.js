const test = require('node:test');
const assert = require('node:assert/strict');

require('../skills.js');
const HHM = require('../matcher.js');

function vacancy(overrides = {}) {
  return {
    title: 'Python-разработчик',
    keySkills: ['Python', 'Docker'],
    description: 'Требования:\nPython, Docker',
    experienceId: 'between3And6',
    languages: [],
    ...overrides
  };
}

test('совпавшие обязательные навыки дают полный балл за технологии', () => {
  const result = HHM.match('Python-разработчик\nОпыт работы — 4 года\nPython, Docker', vacancy());
  const skills = result.criteria.find((criterion) => criterion.key === 'skills');

  assert.equal(skills.score, 1);
  assert.equal(result.experienceFit, true);
});

test('навыки из блока «Будет плюсом» не снижают оценку', () => {
  const result = HHM.match('Python-разработчик\nОпыт работы — 4 года\nPython', vacancy({
    keySkills: ['Python'],
    description: 'Требования:\nPython\nБудет плюсом:\nKubernetes'
  }));
  const skills = result.criteria.find((criterion) => criterion.key === 'skills');

  assert.equal(skills.score, 1);
  assert.deepEqual(skills.optional.map((skill) => skill.name), ['Kubernetes']);
});

test('опыт вне диапазона вакансии помечается как несоответствие', () => {
  const result = HHM.match('Python-разработчик\nОпыт работы — 8 лет\nPython, Docker', vacancy());

  assert.equal(result.experienceFit, false);
});
