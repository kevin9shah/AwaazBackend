using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Networking;
using Newtonsoft.Json;

namespace PresentationVR
{
    [System.Serializable]
    public class PresentationData
    {
        public string code;
        public string title;
        public int slideCount;
        public bool hasImages;
        public Dictionary<string, string> slideUrls;
        public Dictionary<string, string> slideTexts;
        public Dictionary<string, string[]> questions;
        public Dictionary<string, string> speechContent;
        public string createdAt;
    }

    [System.Serializable]
    public class PresentationResponse
    {
        public bool success;
        public PresentationData presentation;
    }

    [System.Serializable]
    public class UploadResponse
    {
        public bool success;
        public string code;
        public int slideCount;
        public bool hasImages;
        public string message;
    }

    public class PresentationManager : MonoBehaviour
    {
        [Header("API Configuration")]
        [SerializeField] private string apiBaseUrl = "http://localhost:3000/api";
        
        [Header("Current Presentation")]
        [SerializeField] private PresentationData currentPresentation;
        [SerializeField] private Dictionary<int, Texture2D> slideImages = new Dictionary<int, Texture2D>();
        
        [Header("Events")]
        public UnityEngine.Events.UnityEvent<PresentationData> OnPresentationLoaded;
        public UnityEngine.Events.UnityEvent<int, Texture2D> OnSlideImageLoaded;
        public UnityEngine.Events.UnityEvent<string> OnError;

        // Load presentation by code
        public void LoadPresentation(string presentationCode)
        {
            StartCoroutine(LoadPresentationCoroutine(presentationCode));
        }

        private IEnumerator LoadPresentationCoroutine(string code)
        {
            string url = $"{apiBaseUrl}/presentation/{code}";
            
            using (UnityWebRequest request = UnityWebRequest.Get(url))
            {
                yield return request.SendWebRequest();

                if (request.result == UnityWebRequest.Result.Success)
                {
                    try
                    {
                        string jsonResponse = request.downloadHandler.text;
                        PresentationResponse response = JsonConvert.DeserializeObject<PresentationResponse>(jsonResponse);
                        
                        if (response.success)
                        {
                            currentPresentation = response.presentation;
                            OnPresentationLoaded?.Invoke(currentPresentation);
                            
                            // Load slide images if available
                            if (currentPresentation.hasImages && currentPresentation.slideUrls != null)
                            {
                                StartCoroutine(LoadSlideImages());
                            }
                            
                            Debug.Log($"Successfully loaded presentation: {currentPresentation.title}");
                        }
                        else
                        {
                            OnError?.Invoke("Failed to load presentation");
                        }
                    }
                    catch (Exception e)
                    {
                        OnError?.Invoke($"Error parsing presentation data: {e.Message}");
                    }
                }
                else
                {
                    OnError?.Invoke($"Network error: {request.error}");
                }
            }
        }

        private IEnumerator LoadSlideImages()
        {
            slideImages.Clear();
            
            foreach (var slideUrl in currentPresentation.slideUrls)
            {
                if (int.TryParse(slideUrl.Key, out int slideNumber))
                {
                    yield return StartCoroutine(LoadSingleSlideImage(slideNumber, slideUrl.Value));
                }
            }
        }

        private IEnumerator LoadSingleSlideImage(int slideNumber, string imageUrl)
        {
            using (UnityWebRequest request = UnityWebRequestTexture.GetTexture(imageUrl))
            {
                yield return request.SendWebRequest();

                if (request.result == UnityWebRequest.Result.Success)
                {
                    Texture2D texture = DownloadHandlerTexture.GetContent(request);
                    slideImages[slideNumber] = texture;
                    OnSlideImageLoaded?.Invoke(slideNumber, texture);
                    Debug.log($"Loaded image for slide {slideNumber}");
                }
                else
                {
                    Debug.LogWarning($"Failed to load image for slide {slideNumber}: {request.error}");
                }
            }
        }

        // Get specific slide data
        public string GetSlideText(int slideNumber)
        {
            if (currentPresentation?.slideTexts != null && 
                currentPresentation.slideTexts.ContainsKey(slideNumber.ToString()))
            {
                return currentPresentation.slideTexts[slideNumber.ToString()];
            }
            return string.Empty;
        }

        public string[] GetSlideQuestions(int slideNumber)
        {
            if (currentPresentation?.questions != null && 
                currentPresentation.questions.ContainsKey(slideNumber.ToString()))
            {
                return currentPresentation.questions[slideNumber.ToString()];
            }
            return new string[0];
        }

        public string GetSlideSpeechContent(int slideNumber)
        {
            if (currentPresentation?.speechContent != null && 
                currentPresentation.speechContent.ContainsKey(slideNumber.ToString()))
            {
                return currentPresentation.speechContent[slideNumber.ToString()];
            }
            return string.Empty;
        }

        public Texture2D GetSlideImage(int slideNumber)
        {
            if (slideImages.ContainsKey(slideNumber))
            {
                return slideImages[slideNumber];
            }
            return null;
        }

        // Get all data for VR presentation
        public PresentationVRData GetVRPresentationData()
        {
            if (currentPresentation == null) return null;

            var vrData = new PresentationVRData
            {
                title = currentPresentation.title,
                totalSlides = currentPresentation.slideCount,
                slides = new List<SlideVRData>()
            };

            for (int i = 1; i <= currentPresentation.slideCount; i++)
            {
                var slideData = new SlideVRData
                {
                    slideNumber = i,
                    text = GetSlideText(i),
                    speechContent = GetSlideSpeechContent(i),
                    questions = GetSlideQuestions(i),
                    image = GetSlideImage(i)
                };
                vrData.slides.Add(slideData);
            }

            return vrData;
        }

        // Upload new presentation (for future use)
        public void UploadPresentation(byte[] pdfData, string title)
        {
            StartCoroutine(UploadPresentationCoroutine(pdfData, title));
        }

        private IEnumerator UploadPresentationCoroutine(byte[] pdfData, string title)
        {
            WWWForm form = new WWWForm();
            form.AddBinaryData("pdf", pdfData, "presentation.pdf", "application/pdf");
            form.AddField("title", title);

            string url = $"{apiBaseUrl}/upload-presentation";
            
            using (UnityWebRequest request = UnityWebRequest.Post(url, form))
            {
                yield return request.SendWebRequest();

                if (request.result == UnityWebRequest.Result.Success)
                {
                    try
                    {
                        string jsonResponse = request.downloadHandler.text;
                        UploadResponse response = JsonConvert.DeserializeObject<UploadResponse>(jsonResponse);
                        
                        if (response.success)
                        {
                            Debug.Log($"Upload successful! Code: {response.code}");
                            // Automatically load the uploaded presentation
                            LoadPresentation(response.code);
                        }
                        else
                        {
                            OnError?.Invoke("Upload failed");
                        }
                    }
                    catch (Exception e)
                    {
                        OnError?.Invoke($"Error parsing upload response: {e.Message}");
                    }
                }
                else
                {
                    OnError?.Invoke($"Upload error: {request.error}");
                }
            }
        }

        // Utility methods for VR/AR
        public bool IsLoaded => currentPresentation != null;
        public int GetTotalSlides() => currentPresentation?.slideCount ?? 0;
        public string GetPresentationTitle() => currentPresentation?.title ?? "No Presentation";
        public bool HasImages() => currentPresentation?.hasImages ?? false;
    }

    // VR-specific data structures
    [System.Serializable]
    public class PresentationVRData
    {
        public string title;
        public int totalSlides;
        public List<SlideVRData> slides;
    }

    [System.Serializable]
    public class SlideVRData
    {
        public int slideNumber;
        public string text;
        public string speechContent;
        public string[] questions;
        public Texture2D image;
    }

    // Example VR Controller Script
    [System.Serializable]
    public class VRPresentationController : MonoBehaviour
    {
        [Header("VR Components")]
        [SerializeField] private PresentationManager presentationManager;
        [SerializeField] private GameObject slidePrefab;
        [SerializeField] private Transform slideContainer;
        [SerializeField] private TMPro.TextMeshPro slideTextDisplay;
        [SerializeField] private TMPro.TextMeshPro speechContentDisplay;
        [SerializeField] private TMPro.TextMeshPro questionsDisplay;
        
        private PresentationVRData vrData;
        private int currentSlideIndex = 0;
        private List<GameObject> slideObjects = new List<GameObject>();

        private void Start()
        {
            // Subscribe to presentation manager events
            presentationManager.OnPresentationLoaded.AddListener(OnPresentationLoaded);
            presentationManager.OnSlideImageLoaded.AddListener(OnSlideImageLoaded);
        }

        private void OnPresentationLoaded(PresentationData presentation)
        {
            vrData = presentationManager.GetVRPresentationData();
            SetupVRPresentation();
        }

        private void OnSlideImageLoaded(int slideNumber, Texture2D image)
        {
            // Update the corresponding slide object with the image
            if (slideNumber <= slideObjects.Count)
            {
                var slideObject = slideObjects[slideNumber - 1];
                var renderer = slideObject.GetComponent<Renderer>();
                if (renderer != null)
                {
                    renderer.material.mainTexture = image;
                }
            }
        }

        private void SetupVRPresentation()
        {
            // Clear existing slides
            foreach (var obj in slideObjects)
            {
                DestroyImmediate(obj);
            }
            slideObjects.Clear();

            // Create slide objects in VR space
            for (int i = 0; i < vrData.slides.Count; i++)
            {
                Vector3 position = new Vector3(i * 3f, 0, 0); // Arrange slides horizontally
                GameObject slideObj = Instantiate(slidePrefab, position, Quaternion.identity, slideContainer);
                slideObjects.Add(slideObj);
                
                // Set slide text if available
                var textComponent = slideObj.GetComponentInChildren<TMPro.TextMeshPro>();
                if (textComponent != null)
                {
                    textComponent.text = vrData.slides[i].text;
                }
            }

            // Show first slide
            ShowSlide(0);
        }

        public void NextSlide()
        {
            if (currentSlideIndex < vrData.slides.Count - 1)
            {
                currentSlideIndex++;
                ShowSlide(currentSlideIndex);
            }
        }

        public void PreviousSlide()
        {
            if (currentSlideIndex > 0)
            {
                currentSlideIndex--;
                ShowSlide(currentSlideIndex);
            }
        }

        private void ShowSlide(int index)
        {
            if (vrData == null || index >= vrData.slides.Count) return;

            var slide = vrData.slides[index];
            
            // Update UI displays
            if (slideTextDisplay != null)
                slideTextDisplay.text = slide.text;
            
            if (speechContentDisplay != null)
                speechContentDisplay.text = $"Speech: {slide.speechContent}";
            
            if (questionsDisplay != null && slide.questions != null)
                questionsDisplay.text = $"Questions:\n{string.Join("\n", slide.questions)}";

            // Focus camera on current slide
            if (index < slideObjects.Count)
            {
                Transform slideTransform = slideObjects[index].transform;
                // You can add smooth camera movement here
            }

            Debug.Log($"Showing slide {index + 1}: {slide.text}");
        }

        // VR Input handlers (you can connect these to VR controller inputs)
        public void OnVRNextButtonPressed() => NextSlide();
        public void OnVRPreviousButtonPressed() => PreviousSlide();
        
        public void LoadPresentationByCode(string code)
        {
            presentationManager.LoadPresentation(code);
        }
    }
}
