const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const admin = require('firebase-admin');
const multer = require('multer');
const path = require('path');

// Initialize Firebase

const serviceAccount = require('./firebaseConfig.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://library-190a0.firebaseio.com"
});

const db = admin.firestore();




const app =express();

// Set storage configuration for multer
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'public/uploads/'); // Folder where uploaded images will be stored
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname)); // Ensure unique filenames
  }
});

// Initialize multer with the storage configuration
const upload = multer({ storage: storage });

// ==================== Middleware ====================
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');


// Session Middleware
app.use(session({
  secret: 'secret-key',
  resave: false,
  saveUninitialized: true
}));

// Initialize cart and orders in session
app.use((req, res, next) => {
  if (!req.session.cart) req.session.cart = [];
  if (!req.session.orders) req.session.orders = [];
  next();
});


// ==================== Helper Functions ====================
async function getBooks() {
  const snapshot = await db.collection('books').get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function getRecords(role) {
  const snapshot = await db.collection(role).get();
  return snapshot.docs.map(doc => doc.data());
}

async function registerBook(role, title, name) {
  const bookRef = db.collection('books').doc(title);
  const book = await bookRef.get();

  if (book.exists && book.data().available > 0) {
    await bookRef.update({ available: book.data().available - 1 });
    await db.collection(role).add({
      name,
      title,
      date: new Date().toISOString()
    });
  }
}

// ==================== Routes ====================

// ----- LOGIN & SIGNUP -----
app.get('/', (req, res) => {
  res.render('main');
});
app.get('/signup', (req, res) => res.render('signup'));

// Handle Sign-Up
app.post('/signup', async (req, res) => {
  const {
    firstName = '',
    lastName = '',
    email = '',
    phone = '',
    address = '',
    city = '',
    state = '',
    zip = '',
    role = '',
    password = '',
  } = req.body;

  try {
    // Reference to the Firestore database collection
    const userRef = db.collection('users').doc(email);
    const user = await userRef.get();

    // Check if the user already exists
    if (user.exists) {
      return res.send('User already exists. <a href=\"/\">Login</a>');
    }

    // Create a new user document in Firestore
    await userRef.set({
      firstName: firstName || null,
      lastName: lastName || null,
      email: email || null,
      phone: phone || null,
      address: address || null,
      city: city || null,
      state: state || null,
      zip: zip || null,
      role: role || null,
      password: password || null, // In production, you should hash passwords before storing
    });

    // Successful sign-up response
    res.send('Sign-Up Successful! <a href=\"/\">Login</a>');
  } catch (error) {
    // Log the error and return a failure response
    console.error('Error signing up:', error);
    res.status(500).send('Error during sign-up.');
  }
});
app.get('/feedback', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'librarian') {
    return res.redirect('/feedback'); // Redirect if not logged in as librarian
  }

  try {
    // Fetch all contact details from Firestore
    const contactsSnapshot = await db.collection('contacts').orderBy('timestamp', 'desc').get();
    const contacts = contactsSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    // Render the feedback page with the contact details
    res.render('feedback', { contacts });
  } catch (error) {
    console.error('Error fetching contact details:', error);
    res.status(500).send('Error fetching feedback data.');
  }
});
// Route to remove feedback
app.post('/feedback/remove/:contactId', async (req, res) => {
  const contactId = req.params.contactId;

  try {
    // Reference to the contact document in Firestore
    const contactRef = db.collection('contacts').doc(contactId);

    // Delete the contact document
    await contactRef.delete();

    // Redirect to feedback page after deletion
    res.redirect('/feedback');
  } catch (error) {
    console.error('Error deleting contact:', error);
    res.status(500).send('Error deleting contact. Please try again later.');
  }
});

app.get('/contact', (req, res) => {
  res.render('contact');
});

// Handle form submission
app.post('/contact', async (req, res) => {
  const { fullName, email, phone, message } = req.body;

  try {
    // Save contact details to Firestore
    const contactRef = db.collection('contacts').doc();
    await contactRef.set({
      fullName,
      email,
      phone,
      message,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Send a success response
    res.send('Thank you for contacting us! We will get back to you shortly.');
  } catch (error) {
    console.error('Error saving contact form data:', error);
    res.status(500).send('Something went wrong. Please try again later.');
  }
});
// Handle Login
// ----- LOGIN -----

// ----- LOGIN ROUTE -----
app.get('/login', (req, res) => {
  res.render('login');
});
app.post('/login', async (req, res) => {
  const { email, password, role } = req.body;
  try {
    const userRef = db.collection('users').doc(email);
    const userDoc = await userRef.get();

    if (!userDoc.exists || userDoc.data().password !== password || userDoc.data().role !== role) {
      return res.redirect('/?error=true');
    }

    const userData = userDoc.data();

    req.session.user = {
      email,
      role,
      name: userData.name,  // Store additional signup data like name
      cart: userData.cart || [],
      orders: userData.orders || [],
      // Add any other data you want to store in the session
    };

    switch (role) {
      case 'student': res.redirect('/student'); break;
      case 'teacher': res.redirect('/teacher'); break;
      case 'librarian': res.redirect('/librarian'); break;
      default: res.redirect('/');
    }
  } catch (error) {
    console.error('Error logging in:', error);
    res.status(500).send('Error during login.');
  }
});

// ----- STUDENT PAGE -----
app.get('/student', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const searchQuery = req.query.search || "";
  try {
    const booksSnapshot = await db.collection('books').get();
    let books = booksSnapshot.docs.map(doc => doc.data());

    // Filter books based on search query
    if (searchQuery) {
      books = books.filter(book =>
        book.title.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }

    res.render('student', {
      books,
      cart: req.session.user.cart,
      searchQuery,
    });
  } catch (error) {
    console.error('Error fetching books:', error);
    res.status(500).send('Error fetching books.');
  }
});

// ----- ADD TO CART -----
app.post('/add-to-cart', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const { title } = req.body;
  const userEmail = req.session.user.email;

  try {
    const userRef = db.collection('users').doc(userEmail);
    const userDoc = await userRef.get();

    // Fetch book details from Firestore
    const bookRef = db.collection('books').doc(title);
    const bookDoc = await bookRef.get();

    if (!bookDoc.exists) {
      return res.status(404).json({ message: 'Book not found.' });
    }

    const bookData = bookDoc.data();

    const cart = userDoc.data().cart || [];
    if (cart.some(item => item.title === title)) {
      return res.status(400).json({ message: 'Book already in cart.', cartCount: cart.length });
    }

    // Add book title and author to the cart
    cart.push({ title, author: bookData.author });

    // Update cart in Firestore
    await userRef.update({ cart });

    // Update cart in session
    req.session.user.cart = cart;

    res.json({ message: 'Book added to cart.', cartCount: cart.length });
  } catch (error) {
    console.error('Error adding to cart:', error);
    res.status(500).send('Error adding to cart.');
  }
});


// ----- VIEW CART -----
app.get('/cart', (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  // Retrieve the user's cart from the session
  const userCart = req.session.user.cart || [];

  // Render the cart page with the book details (title and author)
  res.render('cart', { cart: userCart });
});

// ----- REMOVE FROM CART -----
app.post('/remove-from-cart', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const index = parseInt(req.body.index, 10);
  const userEmail = req.session.user.email;

  try {
    const userRef = db.collection('users').doc(userEmail);
    const userDoc = await userRef.get();

    const cart = userDoc.data().cart || [];
    if (index >= 0 && index < cart.length) {
      cart.splice(index, 1);

      // Update cart in Firebase
      await userRef.update({ cart });

      // Update cart in session
      req.session.user.cart = cart;
    }

    res.redirect('/cart');
  } catch (error) {
    console.error('Error removing from cart:', error);
    res.status(500).send('Error removing from cart.');
  }
});


// ----- PLACE ORDER -----
app.post('/order', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const { title } = req.body;
  const userEmail = req.session.user.email;

  try {
    const userRef = db.collection('users').doc(userEmail);
    const userDoc = await userRef.get();

    const cart = userDoc.data().cart || [];
    const orders = userDoc.data().orders || [];

    // Check if the ordered item exists in the cart
    const cartItem = cart.find(item => item.title === title);
    if (!cartItem) {
      return res.status(400).send('<h1>Item not in cart!</h1><a href="/cart">Go back</a>');
    }

    // Check if the book is already in the user's orders
    const alreadyOrdered = orders.some(order => order.title === title);
    if (alreadyOrdered) {
      return res.status(400).send('<h1>Book already ordered!</h1><a href="/cart">Go back</a>');
    }

    // Check book availability
    const bookRef = db.collection('books').doc(title);
    const book = await bookRef.get();

    if (!book.exists) {
      return res.status(404).send('<h1>Book not found!</h1><a href="/cart">Go back</a>');
    }

    const bookData = book.data();

    if (bookData.available <= 0) {
      return res.status(400).send('<h1>Book is out of stock!</h1><a href="/cart">Go back</a>');
    }

    // Reduce the available count of the book
    await bookRef.update({ available: bookData.available - 1 });

    // Add the item to orders
    const newOrder = { 
      id: Date.now().toString(), 
      title, 
      date: new Date().toISOString(),  // Store as ISO string for consistent parsing
      read: false  // Initially, set the read status to false
    };
    orders.push(newOrder);

    // Update orders in Firebase
    await userRef.update({ orders });

    // Update orders in session
    req.session.user.orders = orders;

    // Fetch user's first and last name, ensuring they exist
    const firstName = userDoc.data().firstName || '';  // Provide a default empty string if undefined
    const lastName = userDoc.data().lastName || '';    // Provide a default empty string if undefined

    // Create an alert for the librarian
    const alert = {
      userFirstName: firstName,
      userLastName: lastName,
      title,
      date: new Date().toISOString(),
      read: false,  // The alert is unread initially
      type: 'order'  // Mark it as an order alert
    };

    // Only add the alert if firstName and lastName are not undefined or empty
    if (firstName && lastName) {
      await db.collection('alerts').add(alert);
    }

    res.redirect('/orders');
  } catch (error) {
    console.error('Error placing order:', error);
    res.status(500).send('<h1>Error placing order. Try again later.</h1>');
  }
});




// ----- VIEW ORDERS ----- 
app.get('/orders', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const userEmail = req.session.user.email;

  try {
    const userRef = db.collection('users').doc(userEmail);
    const userDoc = await userRef.get();

    const orders = userDoc.data().orders || [];

    // Format the date for rendering
    orders.forEach(order => {
      if (order.date) {
        order.date = new Date(order.date).toLocaleDateString(); // Convert ISO string to readable format
      } else {
        order.date = 'N/A'; // Fallback for missing dates
      }
    });

    res.render('orders', { orders });
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).send('Error fetching orders.');
  }
});



// ----- CANCEL ORDER -----
app.post('/cancel-order', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const orderId = req.body.orderId; // ID of the order to be canceled
  const userEmail = req.session.user.email;

  try {
    const userRef = db.collection('users').doc(userEmail);
    const userDoc = await userRef.get();

    const orders = userDoc.data().orders || [];
    const canceledOrder = orders.find(order => order.id === orderId);

    if (!canceledOrder) {
      return res.status(404).send('<h1>Order not found!</h1><a href="/orders">Go back</a>');
    }

    // Get the book title from the canceled order
    const { title } = canceledOrder;

    // Update the book's availability
    const bookRef = db.collection('books').doc(title);
    const book = await bookRef.get();

    if (book.exists) {
      const bookData = book.data();

      // Increment the available count
      await bookRef.update({
        available: bookData.available + 1
      });
    }

    // Remove the canceled order from the user's orders
    const updatedOrders = orders.filter(order => order.id !== orderId);

    // Update the user's orders in Firebase
    await userRef.update({ orders: updatedOrders });

    // Update the session data
    req.session.user.orders = updatedOrders;

    res.redirect('/orders');
  } catch (error) {
    console.error('Error canceling order:', error);
    res.status(500).send('<h1>Error canceling order. Try again later.</h1>');
  }
});
// const storage = multer.diskStorage({
//   destination: (req, file, cb) => {
//     const uploadPath = path.join(__dirname, 'public/uploads');
//     cb(null, uploadPath);
//   },
//   filename: (req, file, cb) => {
//     cb(null, `${Date.now()}${path.extname(file.originalname)}`);
//   },
// });

// const upload = multer({ storage });

// Route to Display Profile
app.get('/profile', async (req, res) => {
  if (!req.session.user) return res.redirect('/'); // Redirect to login if not logged in

  try {
    const { email } = req.session.user; // Logged-in user's email
    const userRef = db.collection('users').doc(email);
    const userDoc = await userRef.get();

    if (!userDoc.exists) return res.status(404).send('User not found.');

    const userData = userDoc.data();
    res.render('profile', {
      student: {
        firstName: userData.firstName,  // assuming user has firstName field
        lastName: userData.lastName,    // assuming user has lastName field
        email: userData.email,
        phone: userData.phone,          // assuming user has phone field
        address: userData.address,      // assuming user has address field
        city: userData.city,            // assuming user has city field
        state: userData.state,          // assuming user has state field
        zip: userData.zip,              // assuming user has zip field
        imageUrl: userData.imageUrl || '/images/default-profile.png', // Default profile image
      },
      borrowedBooks: userData.borrowedBooks || [], // If no books, default to an empty array
    });
  } catch (error) {
    console.error('Error fetching profile data:', error);
    res.status(500).send('Error fetching profile data.');
  }
});


// Route to Handle Profile Image Upload
app.post('/profile/update', async (req, res) => {
  try {
    if (!req.session.user) return res.redirect('/'); // Redirect to login if not logged in

    const { firstName, lastName, phone, address, city, state, zip } = req.body;
    const { email } = req.session.user; // Get logged-in user's email

    const userRef = db.collection('users').doc(email);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).send('User not found');
    }

    // Update the user's profile details in Firebase
    await userRef.update({
      firstName: firstName,
      lastName: lastName,
      phone: phone,
      address: address,
      city: city,
      state: state,
      zip: zip,
    });

    // Update session data (optional)
    req.session.user.firstName = firstName;
    req.session.user.lastName = lastName;
    req.session.user.phone = phone;
    req.session.user.address = address;
    req.session.user.city = city;
    req.session.user.state = state;
    req.session.user.zip = zip;

    res.redirect('/profile'); // Redirect to profile page after update
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).send('Error updating profile');
  }
});

// Profile Image Upload Route
app.post('/profile/upload', upload.single('profileImage'), async (req, res) => {
  try {
    if (!req.session.user) return res.redirect('/'); // Redirect to login if not logged in

    const { email } = req.session.user; // Get logged-in user's email
    const imageUrl = `/uploads/${req.file.filename}`; // Path for static serving

    // Update the user's profile in Firebase with the new image URL
    const userRef = db.collection('users').doc(email);
    await userRef.update({
      imageUrl: imageUrl,
    });

    // Update session data
    req.session.user.imageUrl = imageUrl;

    res.redirect('/profile'); // Redirect to profile page to show updated image
  } catch (error) {
    console.error('Error uploading profile image:', error);
    res.status(500).send('Error uploading image');
  }
});
// Route to Remove Profile Image
app.post('/profile/remove', async (req, res) => {
  try {
    const { email } = req.session.user; // Logged-in user's email

    // Update Firebase to remove the image URL
    const userRef = db.collection('users').doc(email);
    await userRef.update({
      imageUrl: admin.firestore.FieldValue.delete(),
    });

    // Update session to reflect the removed image
    req.session.user.imageUrl = null;

    res.redirect('/profile'); // Redirect back to the profile page
  } catch (error) {
    console.error('Error removing profile image:', error);
    res.status(500).send('Error removing profile image.');
  }
});

app.get('/settings', (req, res) => {
  if (!req.session.user) {
    return res.redirect('/'); // Redirect to login if not logged in
  }
  res.render('settings', { user: req.session.user }); // Pass the user session data to the view
});

// POST request for changing password
app.post('/settings/change-password', async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;

  if (newPassword !== confirmPassword) {
    return res.status(400).send('Passwords do not match');
  }

  try {
    const { email } = req.session.user;  // Use email from session
    const userRef = db.collection('users').doc(email);
    const userDoc = await userRef.get();

    if (!userDoc.exists || userDoc.data().password !== currentPassword) {
      return res.status(400).send('Incorrect current password');
    }

    await userRef.update({ password: newPassword });
    res.send('Password changed successfully');
  } catch (error) {
    console.error('Error changing password:', error);
    res.status(500).send('Error during password change');
  }
});

// POST request for logging out
app.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).send('Error logging out');
    }
    res.redirect('/login');  // Redirect to home page after logout
  });
});

// POST request for login (authentication)
app.post('/login', async (req, res) => {
  const { email, password, role } = req.body;
  try {
    const userRef = db.collection('users').doc(email);
    const userDoc = await userRef.get();

    if (!userDoc.exists || userDoc.data().password !== password || userDoc.data().role !== role) {
      return res.redirect('/?error=true');
    }

    const userData = userDoc.data();

    req.session.user = {
      email,
      role,
      name: userData.name,  // Store additional signup data like name
      cart: userData.cart || [],
      orders: userData.orders || [],
      // Add any other data you want to store in the session
    };

    switch (role) {
      case 'student':
        res.redirect('/student');
        break;
      case 'teacher':
        res.redirect('/teacher');
        break;
      case 'librarian':
        res.redirect('/librarian');
        break;
      default:
        res.redirect('/login');
    }
  } catch (error) {
    console.error('Error logging in:', error);
    res.status(500).send('Error during login.');
  }
});

// ----- TEACHER PAGE -----
app.get('/teacher', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const searchQuery = req.query.search || "";
  try {
    const booksSnapshot = await db.collection('books').get();
    let books = booksSnapshot.docs.map(doc => doc.data());

    // Filter books based on search query
    if (searchQuery) {
      books = books.filter(book =>
        book.title.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }

    // Slice to display only first 4 books
    books = books.slice(0, 4);

    res.render('teacher', {
      books,
      searchQuery,
      cart: req.session.cart || []  // Ensure cart is passed to the template
    });
  } catch (error) {
    console.error('Error fetching books:', error);
    res.status(500).send('Error fetching books.');
  }
});

// ----- LIBRARIAN PAGE -----
app.get('/librarian', async (req, res) => {
  if (!req.session.user) {
    return res.redirect('/login'); // Redirect to login if not logged in
  }

  try {
    // Fetch books and records for librarian
    const books = await getBooks();
    const studentRecords = await getRecords('students');
    const teacherRecords = await getRecords('teachers');

    // Fetch unread alerts count (as per previous example)
    const alertsSnapshot = await db.collection('alerts').get();
    const alerts = alertsSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));
    const unreadAlerts = alerts.filter(alert => !alert.read).length;

    // Render the homepage with librarian data and unread alerts count
    res.render('librarian', { books, studentRecords, teacherRecords, unreadAlerts });
  } catch (error) {
    console.error('Error fetching librarian data:', error);
    res.status(500).send('Error fetching data');
  }
});

// Route to render the EJS file
app.get('/data', (req, res) => {
  res.render('data', { user: null }); // Render `data.ejs` and pass `user` as null initially
});

// Route to handle the search form submission
app.get('/search', async (req, res) => {
  if (!req.session.user) return res.redirect('/login'); // Ensure the user is logged in

  const { email, role } = req.query;
  let user = null;

  try {
    if (email) {
      const userRef = db.collection('users').doc(email);
      const userDoc = await userRef.get();

      if (userDoc.exists && userDoc.data().role === role) {
        user = userDoc.data();
        user.orders = user.orders || []; // Ensure orders array exists
      }
    }
  } catch (error) {
    console.error('Error fetching user data:', error);
  }

  res.render('data', { user }); // Render `data.ejs` with the found user
});

// Route to handle the POST request for /updateOrder (updating submission date)
app.post('/updateOrder', async (req, res) => {
  if (!req.session.user) return res.redirect('/login'); // Ensure the user is logged in

  const { email, orderId, submissionDate } = req.body;

  try {
    const userRef = db.collection('users').doc(email);
    const userDoc = await userRef.get();

    if (userDoc.exists) {
      let orders = userDoc.data().orders || [];

      // Find and update the specific order with the submission date
      orders = orders.map(order =>
        order.id === orderId ? { ...order, submissionDate } : order
      );

      // Update the user document with the modified orders array
      await userRef.update({ orders });

      res.redirect(`/search?email=${email}&role=${userDoc.data().role}`);
    } else {
      res.status(404).send('User not found.');
    }
  } catch (error) {
    console.error('Error updating order:', error);
    res.status(500).send('Error updating order.');
  }
});


app.get('/alerts', async (req, res) => {
  if (!req.session.user) {
    return res.redirect('/librarian'); // Redirect to login if not logged in
  }

  try {
    // Fetch the alerts from Firestore
    const alertsSnapshot = await db.collection('alerts').get();
    
    const alerts = alertsSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    // Calculate the number of unread alerts
    const unreadAlerts = alerts.filter(alert => !alert.read).length;

    // Render the alerts page with the alerts and unread alerts count
    res.render('alerts', { alerts, unreadAlerts });
  } catch (error) {
    console.error('Error fetching alerts:', error);
    res.status(500).send('Error fetching alerts');
  }
});


// Route to mark an order as read

// Route to mark an order alert as read
app.post('/alerts/mark-read/:alertId', async (req, res) => {
  const alertId = req.params.alertId;

  try {
    // Get reference to the alert document
    const alertRef = db.collection('alerts').doc(alertId);
    await alertRef.update({ read: true });

    res.status(200).send('Alert marked as read');
  } catch (error) {
    console.error('Error marking alert as read:', error);
    res.status(500).send('Error marking alert as read');
  }
});
// Route to remove an alert
app.post('/alerts/remove/:alertId', async (req, res) => {
  const alertId = req.params.alertId;
  
  try {
    // Delete the alert from the database
    await db.collection('alerts').doc(alertId).delete();

    // Redirect back to the alerts page after removal
    res.redirect('/alerts');
  } catch (error) {
    console.error('Error removing alert:', error);
    res.status(500).send('Error removing alert');
  }
});


// Register Book for Student
app.post('/register-book/student', async (req, res) => {
  const { title, studentName } = req.body;
  await registerBook('students', title, studentName);
  res.redirect('/student');
});

// Register Book for Teacher
app.post('/register-book/teacher', async (req, res) => {
  const { title, teacherName } = req.body;
  await registerBook('teachers', title, teacherName);
  res.redirect('/teacher');
});

// Add a New Book (Librarian)
app.post('/librarian/add-book', async (req, res) => {
  const { title, author, stock } = req.body;

  try {
    const bookRef = db.collection('books').doc(title);
    const book = await bookRef.get();

    if (book.exists) {
      return res.send('<h1>Book already exists!</h1><a href="/librarian">Go back</a>');
    }

    await bookRef.set({
      title,
      author,
      stock,
      available: stock
    });

    res.redirect('/librarian');
  } catch (error) {
    console.error('Error adding book:', error);
    res.status(500).send('<h1>Error adding book. Try again later.</h1>');
  }
});
// Update Book (Librarian)
app.post('/librarian/update-book', async (req, res) => {
  const { title, newStock } = req.body;

  try {
    const bookRef = db.collection('books').doc(title);
    const book = await bookRef.get();

    if (!book.exists) {
      return res.send('<h1>Book not found!</h1><a href="/librarian">Go back</a>');
    }

    const currentData = book.data();
    const addedStock = parseInt(newStock);
    
    if (isNaN(addedStock) || addedStock <= 0) {
      return res.send('<h1>Invalid stock amount.</h1><a href="/librarian">Go back</a>');
    }

    const updatedStock = Number(currentData.stock) + addedStock;
const updatedAvailable = Number(currentData.available) + addedStock;


    await bookRef.update({
      stock: updatedStock,
      available: updatedAvailable
    });

    res.redirect('/librarian');
  } catch (error) {
    console.error('Error updating book:', error);
    res.status(500).send('<h1>Error updating book. Try again later.</h1>');
  }
});


// Borrow Book
app.post('/borrow-book', async (req, res) => {
  const { title, name, role } = req.body;

  try {
    const bookRef = db.collection('books').doc(title);
    const book = await bookRef.get();

    if (!book.exists) {
      return res.send('<h1>Book not found!</h1><a href="/librarian">Go back</a>');
    }

    const bookData = book.data();

    if (bookData.available > 0) {
      // Log the borrowed book without reducing availability
      await db.collection(role).add({
        name,
        title,
        date: new Date().toISOString(),
        status: 'borrowed'
      });

      res.send('<h1>Book borrowed successfully! Availability will update after order placement.</h1>');
    } else {
      res.send('<h1>Sorry, this book is not available right now.</h1>');
    }
  } catch (error) {
    console.error('Error borrowing book:', error);
    res.status(500).send('<h1>Error borrowing book. Try again later.</h1>');
  }
});

// Cart Management

let orders = [];


// ==================== Start Server ====================
const PORT = 3001;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));






