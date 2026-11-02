// Разбор страницы вакансии hh. Работает и с открытой страницей, и с HTML, загруженным через fetch.
(function (root) {
  'use strict';
  const txt = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');

  function parse(doc) {
    const q = (s) => doc.querySelector(s);
    const title = txt(q('[data-qa="vacancy-title"]')) || txt(q('h1'));
    const skills = new Set();
    doc.querySelectorAll('[data-qa="skills-element"], [data-qa="bloko-tag__text"]').forEach((el) => {
      const t = txt(el);
      if (t && t.length < 60) skills.add(t);
    });
    const descEl = q('[data-qa="vacancy-description"]') || q('.vacancy-description');
    const description = descEl ? root.HHSync.blockText(descEl) : '';
    const expText = txt(q('[data-qa="vacancy-experience"]')) || txt(q('[data-qa="work-experience-text"]'));
    const company = txt(q('[data-qa="vacancy-company-name"]')) || txt(q('[data-qa="bloko-header-2"]'));

    // Уже откликались? hh меняет кнопку отклика на «Вы откликнулись» / «Смотреть отклик»
    let applied = false;
    // Смотрим только на кнопку отклика и статус переговоров, не на блок вопросов работодателю
    doc.querySelectorAll('[data-qa^="vacancy-response-link"], [data-qa*="negotiation"], [data-qa*="response-status"]').forEach((el) => {
      if (/вы откликнулись|резюме доставлено|отклик отправлен|смотреть отклик|вас пригласили/i.test(el.textContent || '')) applied = true;
    });
    const archived = /вакансия в архиве|вакансия закрыта/i.test(txt(q('[data-qa="vacancy-archive-description"]')) + txt(q('[data-qa="vacancy-title-archived-text"]')));

    return {
      source: 'страница',
      title,
      company,
      keySkills: Array.from(skills),
      description,
      experienceId: root.HHM.experienceIdFromText(expText),
      languages: [],
      applied,
      archived
    };
  }

  root.HHVacancy = { parse };
})(globalThis);
