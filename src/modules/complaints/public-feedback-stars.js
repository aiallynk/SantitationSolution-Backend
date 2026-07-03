(function () {
  function starValueFromLabel(label) {
    var id = label.getAttribute('for');
    if (!id) return 0;
    var input = document.getElementById(id);
    if (!input || !input.value) return 0;
    var value = parseInt(String(input.value), 10);
    return value >= 1 && value <= 5 ? value : 0;
  }

  function applyStarDisplay(group, rating) {
    var labels = group.querySelectorAll('label');
    var value = Math.max(0, Math.min(5, rating || 0));
    labels.forEach(function (label, idx) {
      label.classList.toggle('is-filled', idx < value);
    });
  }

  function syncFromChecked(group) {
    var checked = group.querySelector('input[type="radio"]:checked');
    applyStarDisplay(group, checked ? parseInt(String(checked.value), 10) : 0);
  }

  function wireStarGroups() {
    document.querySelectorAll('.rating-stars').forEach(function (group) {
      if (group.getAttribute('data-ssms-stars-wired') === '1') return;
      group.setAttribute('data-ssms-stars-wired', '1');
      syncFromChecked(group);

      group.addEventListener('change', function () {
        syncFromChecked(group);
      });
      group.addEventListener('input', function () {
        syncFromChecked(group);
      });

      group.querySelectorAll('label').forEach(function (label) {
        label.addEventListener('mouseenter', function () {
          applyStarDisplay(group, starValueFromLabel(label));
        });
      });

      group.addEventListener('mouseleave', function () {
        syncFromChecked(group);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireStarGroups);
  } else {
    wireStarGroups();
  }
})();
