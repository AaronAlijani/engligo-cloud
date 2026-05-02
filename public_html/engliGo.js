// Run the code only after the webpage is fully loaded
document.addEventListener('DOMContentLoaded', function () {
  const form = document.querySelector('.needs-validation'); // Get the form
  const messageDiv = document.getElementById('form-messages'); // The div for displaying messages

  // This function checks if an email looks correct
  function validateEmail(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // Basic email pattern
    return re.test(String(email).toLowerCase()); // Added String() and toLowerCase() 
  }

  // This function checks if the phone number is only digits and the right length
  function validatePhone(phone) {
    const re = /^[0-9]{8,15}$/; // Accepts only 8 to 15 digits
    return re.test(String(phone)); // Added String()
  }

  if (form) { // Ensure the form exists on the page
    form.addEventListener('submit', async function (event) { // Use async
      event.preventDefault(); // Stop the form from submitting normally

      let isClientValid = true; // Renamed previous isValid for clarity

      // Get all form inputs
      const contactName = document.getElementById('contactName');
      const contactEmail = document.getElementById('contactEmail');
      const contactPhone = document.getElementById('contactPhone');
      const contactBirthdate = document.getElementById('contactBirthdate');
      const contactComment = document.getElementById('contactComment');

      // --- previous Existing Client-Side Validation Logic ---
      // Name validation
      if (contactName.value.trim() === '') {
        contactName.classList.add('is-invalid');
        contactName.classList.remove('is-valid');
        isClientValid = false;
      } else {
        contactName.classList.remove('is-invalid');
        contactName.classList.add('is-valid');
      }

      // Email validation
      if (!validateEmail(contactEmail.value.trim())) { // Added trim()
        contactEmail.classList.add('is-invalid');
        contactEmail.classList.remove('is-valid');
        isClientValid = false;
      } else {
        contactEmail.classList.remove('is-invalid');
        contactEmail.classList.add('is-valid');
      }

      // Phone validation
      if (!validatePhone(contactPhone.value.trim())) { // Added trim()
        contactPhone.classList.add('is-invalid');
        contactPhone.classList.remove('is-valid');
        isClientValid = false;
      } else {
        contactPhone.classList.remove('is-invalid');
        contactPhone.classList.add('is-valid');
      }

      // Birthdate validation 
      if (contactBirthdate.value.trim() === '') { // Added trim()
        contactBirthdate.classList.add('is-invalid');
        contactBirthdate.classList.remove('is-valid');
        isClientValid = false;
      } else {
        // Added client-side date format check, similar to server-side
        contactBirthdate.classList.remove('is-invalid');
        contactBirthdate.classList.add('is-valid');
      }

      // Comment validation
      if (contactComment.value.trim() === '') {
        contactComment.classList.add('is-invalid');
        contactComment.classList.remove('is-valid');
        isClientValid = false;
      } else {
        contactComment.classList.remove('is-invalid');
        contactComment.classList.add('is-valid');
      }

      if (messageDiv) { // Clear previous messages from messageDi which I added to contact form
        messageDiv.textContent = '';
        messageDiv.className = '';
      }

      if (!isClientValid) {
        if (messageDiv) {
          messageDiv.className = 'alert alert-danger mt-3'; // Bootstrap class
          messageDiv.textContent = 'Please correct the errors highlighted in the form.';
        }
        // console.log("Client-side validation failed."); // For debugging
        return; // Stop if client-side validation fails
      }

      // If client-side validation passes, prepare data for the server
      const formDataForServer = {
        // Ensure these keys match with backend expects (contactName, contactEmail, etc.)
        contactName: contactName.value.trim(),
        contactEmail: contactEmail.value.trim(),
        contactPhone: contactPhone.value.trim(),
        contactBirthdate: contactBirthdate.value.trim(),
        contactComment: contactComment.value.trim()
      };

      try {
        const response = await fetch('/submit-contact', { // The backend endpoint
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(formDataForServer)
        });

        const result = await response.json(); // backend sends JSON

        if (response.ok) { // Status 200-299
          if (messageDiv) {
            messageDiv.className = 'alert alert-success mt-3';
            messageDiv.textContent = result.message;
          } else {
            alert(result.message); // Fallback if messageDiv is not found
          }
          form.reset(); // Clear the form fields
          // Remove 'is-valid' classes from all inputs after successful submission
          [contactName, contactEmail, contactPhone, contactBirthdate, contactComment].forEach(input => {
            if (input) input.classList.remove('is-valid');
          });
        } else {
          // Handle errors from the server 
          let errorMessage = result.message || "An unexpected error occurred processing your submission.";
          if (result.errors && Array.isArray(result.errors) && result.errors.length > 0) {
            errorMessage = result.message ? result.message + "\nDetails:\n" : "Please correct the following issues:\n";
            errorMessage += result.errors.join("\n");
          }

          if (messageDiv) {
            messageDiv.className = 'alert alert-danger mt-3';
            // Replace newlines with <br> for HTML display if showing multiple errors
            messageDiv.innerHTML = errorMessage.replace(/\n/g, '<br>');
          } else {
            alert(errorMessage);
          }
        }
      } catch (error) {
        console.error('Fetch submission error:', error);
        const friendlyMessage = 'A network error occurred while submitting the form. Please try again.';
        if (messageDiv) {
          messageDiv.className = 'alert alert-danger mt-3';
          messageDiv.textContent = friendlyMessage;
        } else {
          alert(friendlyMessage);
        }
      }
    });
  }
});