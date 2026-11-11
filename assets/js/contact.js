// Mialink Software LLC — contact form
(function () {
  'use strict';

  var form = document.getElementById('contact-form');
  if (!form) return;

  var status = document.getElementById('contact-status');
  var submit = document.getElementById('contact-submit');
  var topic = document.getElementById('topic');

  // Preselect a topic when a product page links here, e.g. contact.html?topic=mia-beta
  var wanted = new URLSearchParams(window.location.search).get('topic');
  if (topic && wanted) {
    for (var i = 0; i < topic.options.length; i += 1) {
      if (topic.options[i].value === wanted) {
        topic.selectedIndex = i;
        break;
      }
    }
  }

  function setStatus(text, kind) {
    status.textContent = text;
    status.className = 'form-status' + (kind ? ' is-' + kind : '');
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();

    if (!form.checkValidity()) {
      var firstInvalid = form.querySelector(':invalid');
      if (firstInvalid) firstInvalid.focus();
      setStatus('Please fill in your name, a valid email address and a message.', 'error');
      return;
    }

    var payload = {
      name: form.name.value,
      email: form.email.value,
      topic: form.topic.value,
      message: form.message.value,
      website: form.website.value
    };

    submit.disabled = true;
    submit.textContent = 'Sending…';
    setStatus('Sending your message…', null);

    fetch('/api/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          return { ok: response.ok, data: data };
        });
      })
      .then(function (result) {
        if (result.ok && result.data.ok) {
          form.reset();
          setStatus('Thank you — your message has arrived. We will reply to the address you gave.', 'success');
        } else {
          setStatus(result.data.error || 'Your message could not be sent. Please try again.', 'error');
        }
      })
      .catch(function () {
        setStatus('Your message could not be sent. Check your connection and try again.', 'error');
      })
      .then(function () {
        submit.disabled = false;
        submit.textContent = 'Send message';
      });
  });
})();
