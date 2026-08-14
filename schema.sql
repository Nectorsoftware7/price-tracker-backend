CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  password_hash VARCHAR(255), -- NULL for accounts self-registered via Google sign-in
  role ENUM('admin', 'superadmin'), -- NULL until a superadmin approves and assigns one
  status ENUM('pending', 'approved') NOT NULL DEFAULT 'approved',
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  site ENUM('shopify', 'woocommerce', 'flipkart', 'meesho', 'jiomart', 'tira', 'nykaa', 'snapdeal', 'purplle') NOT NULL,
  url VARCHAR(500) NOT NULL,
  price_selector VARCHAR(500),
  stock_selector VARCHAR(500),
  flipkart_sku VARCHAR(100),
  last_price DECIMAL(12,2),
  last_stock ENUM('in_stock', 'low_stock', 'out_of_stock', 'unknown') DEFAULT 'unknown',
  last_stock_quantity INT,
  last_checked_at DATETIME,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_site_url (site, url)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS price_points (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  price DECIMAL(12,2) NOT NULL,
  checked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  INDEX idx_product_checked (product_id, checked_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS stock_events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  status ENUM('in_stock', 'low_stock', 'out_of_stock', 'unknown') NOT NULL,
  raw VARCHAR(500),
  quantity INT,
  checked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  INDEX idx_product_checked (product_id, checked_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS reviews (
  id INT AUTO_INCREMENT PRIMARY KEY,
  source ENUM('wordpress', 'judgeme') NOT NULL,
  external_id VARCHAR(255) NOT NULL,
  product_name VARCHAR(255),
  reviewer_name VARCHAR(255),
  rating INT,
  review_text TEXT,
  reply_text TEXT,
  replied_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_source_external (source, external_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS wp_posts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  site_url VARCHAR(500) NOT NULL,
  post_id INT NOT NULL,
  product_name VARCHAR(255) NOT NULL,
  UNIQUE KEY uniq_site_post (site_url, post_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS contact_submissions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  form_title VARCHAR(255),
  site_name VARCHAR(255),
  site_url VARCHAR(500),
  platform ENUM('shopify', 'woocommerce'),
  name VARCHAR(255),
  email VARCHAR(255),
  phone VARCHAR(50),
  message TEXT,
  ai_reply TEXT,
  email_sent TINYINT(1) NOT NULL DEFAULT 0,
  email_error VARCHAR(500),
  manual_reply TEXT,
  manual_reply_sent_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;
