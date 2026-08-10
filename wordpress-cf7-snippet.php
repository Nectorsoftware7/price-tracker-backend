<?php
/**
 * Sends every Contact Form 7 submission to the price-tracker server, which
 * generates an AI reply (Hermes via OpenRouter), emails it to the customer,
 * and posts an audit message to Telegram.
 *
 * HOW TO INSTALL:
 * 1. Install the free "Code Snippets" plugin (WP Admin -> Plugins -> Add New).
 * 2. Code Snippets -> Add New. Paste this whole file's contents in.
 * 3. Set it to run "Only on site front-end" (or "Everywhere"), Activate, Save.
 * 4. Replace the two CONFIG values below with your real server URL and secret
 *    (the secret must match CF7_WEBHOOK_SECRET in the server's .env file).
 *
 * Alternative: paste the code (without the <?php tag) into your child theme's
 * functions.php instead of using a plugin.
 */

// ---- CONFIG ----
define('PRICE_TRACKER_WEBHOOK_URL', 'https://your-deployed-server.example.com/api/contact-form/wordpress-webhook');
define('PRICE_TRACKER_WEBHOOK_SECRET', 'paste-the-same-CF7_WEBHOOK_SECRET-here');
// ----------------

add_action('wpcf7_mail_sent', function ($contact_form) {
    $submission = WPCF7_Submission::get_instance();
    if (!$submission) {
        return;
    }

    $data = $submission->get_posted_data();

    wp_remote_post(PRICE_TRACKER_WEBHOOK_URL, [
        'timeout'  => 15,
        'blocking' => false, // don't make the visitor wait for our server
        'headers'  => [
            'Content-Type'    => 'application/json',
            'X-Form-Secret'   => PRICE_TRACKER_WEBHOOK_SECRET,
        ],
        'body' => wp_json_encode([
            'formTitle' => $contact_form->title(),
            'siteName'  => get_bloginfo('name'),
            'siteUrl'   => home_url(),
            'fields'    => $data,
        ]),
    ]);
});
